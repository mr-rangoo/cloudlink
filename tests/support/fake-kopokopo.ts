import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";

/**
 * In-process fake of the Kopo Kopo K2 Connect endpoints Cloudlink uses, following the API reference and the
 * official Node SDK: form-encoded client-credentials token, POST /api/v2/incoming_payments (201 + Location),
 * GET of that location (Pending / Success / Failed), and callbacks signed with X-KopoKopo-Signature
 * (hex HMAC-SHA256 of the body with the API key). It rejects what K2 rejects (bad credentials, missing fields).
 */
export interface K2Request {
  id: string;
  body: {
    payment_channel: string;
    till_number: string;
    subscriber: { first_name: string; last_name: string; phone_number: string };
    amount: { currency: string; value: number };
    metadata: Record<string, string>;
    _links: { callback_url: string };
  };
}

export class FakeKopoKopo {
  clientId = "fake-k2-client-id-123";
  clientSecret = "fake-k2-client-secret-456";
  apiKey = "fake-k2-api-key-789-signing";
  tillNumber = "K000123";
  port = 0;
  readonly tokens = new Set<string>();
  readonly requests: K2Request[] = [];
  readonly queries: string[] = [];
  /** Final outcome per request id; absent = Pending. */
  readonly outcomes = new Map<string, { status: "Success"; reference: string; amount: string; currency?: string } | { status: "Failed"; errors: string[] }>();
  private server: http.Server | null = null;

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => this.handle(req, raw, res));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server!.address() as { port: number }).port;
  }

  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  reset() {
    this.tokens.clear();
    this.requests.length = 0;
    this.queries.length = 0;
    this.outcomes.clear();
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  }

  private authorised(req: http.IncomingMessage) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return Boolean(m && this.tokens.has(m[1]!));
  }

  /** The body K2 returns for a status query and posts to the callback URL. */
  resultBody(id: string) {
    const r = this.requests.find((x) => x.id === id)!;
    const o = this.outcomes.get(id);
    const resource =
      o?.status === "Success"
        ? { id: randomUUID(), reference: o.reference, origination_time: "2026-10-30T09:30:40+03:00", sender_phone_number: r.body.subscriber.phone_number, amount: o.amount, currency: o.currency ?? "KES", till_number: r.body.till_number, system: "Lipa Na M-PESA", status: "Received", sender_first_name: "Joe", sender_middle_name: null, sender_last_name: "Buyer" }
        : null;
    return {
      data: {
        id,
        type: "incoming_payment",
        attributes: {
          initiation_time: "2026-10-30T09:30:34.331+03:00",
          status: o ? o.status : "Pending",
          event: { type: "Incoming Payment Request", resource, errors: o?.status === "Failed" ? o.errors : null },
          metadata: r.body.metadata,
          _links: { callback_url: r.body._links.callback_url, self: `${this.baseUrl}/api/v2/incoming_payments/${id}` },
        },
      },
    };
  }

  /** Sign a body the way K2 does. */
  sign(body: string, key = this.apiKey) {
    return createHmac("sha256", key).update(body).digest("hex");
  }

  private handle(req: http.IncomingMessage, raw: string, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.baseUrl);
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(raw);
      if (req.headers["content-type"] !== "application/x-www-form-urlencoded" || form.get("grant_type") !== "client_credentials") return this.json(res, 400, { error: "invalid_request" });
      if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) return this.json(res, 401, { error: "invalid_client", error_description: "Client authentication failed" });
      const token = `k2tok_${randomUUID()}`;
      this.tokens.add(token);
      return this.json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 3600, created_at: 1 });
    }
    if (req.method === "POST" && url.pathname === "/api/v2/incoming_payments") {
      if (!this.authorised(req)) return this.json(res, 401, { error_code: 401, error_message: "Unauthorized" });
      const body = JSON.parse(raw) as K2Request["body"];
      const problems: string[] = [];
      if (body.payment_channel !== "M-PESA STK Push") problems.push("payment_channel");
      if (body.till_number !== this.tillNumber) problems.push("till_number");
      if (!/^\+254[17]\d{8}$/.test(body.subscriber?.phone_number ?? "")) problems.push("phone_number");
      if (body.amount?.currency !== "KES" || !Number.isFinite(body.amount?.value) || body.amount.value <= 0) problems.push("amount");
      if (!body._links?.callback_url) problems.push("callback_url");
      if (Object.keys(body.metadata ?? {}).length > 5) problems.push("metadata");
      if (problems.length) return this.json(res, 400, { error_code: 400, error_message: `Invalid: ${problems.join(", ")}` });
      const id = randomUUID();
      this.requests.push({ id, body });
      return this.json(res, 201, {}, { location: `${this.baseUrl}/api/v2/incoming_payments/${id}` });
    }
    const m = /^\/api\/v2\/incoming_payments\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      if (!this.authorised(req)) return this.json(res, 401, { error_code: 401, error_message: "Unauthorized" });
      this.queries.push(m[1]!);
      if (!this.requests.some((r) => r.id === m[1])) return this.json(res, 404, { error_message: "Not found" });
      return this.json(res, 200, this.resultBody(m[1]!));
    }
    return this.json(res, 404, { error_message: "Not found" });
  }
}
