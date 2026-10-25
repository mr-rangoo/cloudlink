import http from "node:http";

/**
 * In-process fake of the Safaricom Daraja endpoints Cloudlink uses, following the public documentation:
 * OAuth (client credentials, Basic auth), STK Push, STK Push Query and C2B URL registration.
 * It validates what Daraja validates (bearer token, STK password = base64(shortcode + passkey + timestamp),
 * phone format, integer amount, no "mpesa"/"safaricom" in registered URLs) so adapter bugs fail here first.
 */
export interface StkRequestRecord {
  BusinessShortCode: string;
  Password: string;
  Timestamp: string;
  TransactionType: string;
  Amount: number;
  PartyA: string;
  PartyB: string;
  PhoneNumber: string;
  CallBackURL: string;
  AccountReference: string;
  TransactionDesc: string;
  MerchantRequestID: string;
  CheckoutRequestID: string;
}

type Failure = { path: string; status: number; body: Record<string, unknown> } | { path: string; drop: true };

export class FakeDaraja {
  consumerKey = "fake-consumer-key-123";
  consumerSecret = "fake-consumer-secret-456";
  passkey = "fake-passkey-bfb279f9aa9bdbcf158e97dd71a467cd";
  shortcode = "174379";
  port = 0;
  readonly tokens = new Set<string>();
  readonly stkRequests: StkRequestRecord[] = [];
  readonly queries: string[] = [];
  readonly registrations: Array<Record<string, unknown>> = [];
  /** Final result per CheckoutRequestID; absent = still processing. */
  readonly results = new Map<string, string>();
  failures: Failure[] = [];
  tokenRequests = 0;
  private seq = 0;
  private server?: http.Server;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server!.address() as { port: number }).port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  reset() {
    this.tokens.clear();
    this.stkRequests.length = 0;
    this.queries.length = 0;
    this.registrations.length = 0;
    this.results.clear();
    this.failures = [];
    this.tokenRequests = 0;
  }

  /** Build the callback Daraja would POST for a request. */
  callbackBody(checkoutRequestId: string, resultCode: string, opts: { amount?: number; receipt?: string; phone?: string } = {}) {
    const r = this.stkRequests.find((x) => x.CheckoutRequestID === checkoutRequestId);
    if (!r) throw new Error(`unknown checkout ${checkoutRequestId}`);
    return {
      Body: {
        stkCallback: {
          MerchantRequestID: r.MerchantRequestID,
          CheckoutRequestID: r.CheckoutRequestID,
          ResultCode: Number(resultCode),
          ResultDesc: resultCode === "0" ? "The service request is processed successfully." : "Request cancelled by user",
          ...(resultCode === "0"
            ? {
                CallbackMetadata: {
                  Item: [
                    { Name: "Amount", Value: opts.amount ?? r.Amount },
                    { Name: "MpesaReceiptNumber", Value: opts.receipt ?? `RKT${String(++this.seq).padStart(7, "0")}` },
                    { Name: "Balance" },
                    { Name: "TransactionDate", Value: 20261025143012 },
                    { Name: "PhoneNumber", Value: Number(opts.phone ?? r.PhoneNumber) },
                  ],
                },
              }
            : {}),
        },
      },
    };
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const failure = this.failures.find((f) => url.pathname.startsWith(f.path));
    if (failure) {
      this.failures.splice(this.failures.indexOf(failure), 1);
      if ("drop" in failure) return void req.socket.destroy();
      return this.send(res, failure.status, failure.body);
    }

    if (req.method === "GET" && url.pathname === "/oauth/v1/generate") {
      this.tokenRequests++;
      const expected = `Basic ${Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString("base64")}`;
      if (url.searchParams.get("grant_type") !== "client_credentials" || req.headers.authorization !== expected) {
        return this.send(res, 400, { requestId: "r-1", errorCode: "400.008.01", errorMessage: "Invalid Authentication passed" });
      }
      const token = `tok${Math.random().toString(36).slice(2)}`;
      this.tokens.add(token);
      return this.send(res, 200, { access_token: token, expires_in: "3599" });
    }

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.tokens.has(bearer)) return this.send(res, 401, { requestId: "r-2", errorCode: "404.001.03", errorMessage: "Invalid Access Token" });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.send(res, 400, { errorCode: "400.002.05", errorMessage: "Invalid Request Payload" });
    }
    const passwordOk = (b: Record<string, unknown>) =>
      /^\d{14}$/.test(String(b.Timestamp)) && b.Password === Buffer.from(`${b.BusinessShortCode}${this.passkey}${b.Timestamp}`).toString("base64");

    if (url.pathname === "/mpesa/stkpush/v1/processrequest") {
      if (!passwordOk(body)) return this.send(res, 400, { requestId: "r-3", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Password" });
      if (!/^254[17]\d{8}$/.test(String(body.PhoneNumber)) || body.PhoneNumber !== body.PartyA) return this.send(res, 400, { requestId: "r-4", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" });
      if (!Number.isInteger(body.Amount) || (body.Amount as number) < 1) return this.send(res, 400, { requestId: "r-5", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Amount" });
      if (String(body.AccountReference).length > 12 || String(body.TransactionDesc).length > 13) return this.send(res, 400, { requestId: "r-6", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid AccountReference" });
      const n = ++this.seq;
      const record = { ...(body as unknown as StkRequestRecord), MerchantRequestID: `29115-${n}-1`, CheckoutRequestID: `ws_CO_25102026${String(n).padStart(6, "0")}` };
      this.stkRequests.push(record);
      return this.send(res, 200, {
        MerchantRequestID: record.MerchantRequestID,
        CheckoutRequestID: record.CheckoutRequestID,
        ResponseCode: "0",
        ResponseDescription: "Success. Request accepted for processing",
        CustomerMessage: "Success. Request accepted for processing",
      });
    }

    if (url.pathname === "/mpesa/stkpushquery/v1/query") {
      if (!passwordOk(body)) return this.send(res, 400, { requestId: "r-7", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid Password" });
      const id = String(body.CheckoutRequestID);
      this.queries.push(id);
      const result = this.results.get(id);
      if (result === undefined) return this.send(res, 500, { requestId: "r-8", errorCode: "500.001.1001", errorMessage: "The transaction is being processed" });
      const r = this.stkRequests.find((x) => x.CheckoutRequestID === id);
      return this.send(res, 200, {
        ResponseCode: "0",
        ResponseDescription: "The service request has been accepted successsfully",
        MerchantRequestID: r?.MerchantRequestID,
        CheckoutRequestID: id,
        ResultCode: result,
        ResultDesc: result === "0" ? "The service request is processed successfully." : "Request cancelled by user",
      });
    }

    if (url.pathname === "/mpesa/c2b/v1/registerurl") {
      const urls = `${body.ConfirmationURL} ${body.ValidationURL}`.toLowerCase();
      if (/m-?pesa|safaricom/.test(urls)) return this.send(res, 400, { requestId: "r-9", errorCode: "400.003.02", errorMessage: "Bad Request - Invalid ConfirmationURL" });
      this.registrations.push(body);
      return this.send(res, 200, { OriginatorCoversationID: "6e86-45dd-91ac-fd5d4178ab523408729", ResponseCode: "0", ResponseDescription: "Success" });
    }

    return this.send(res, 404, { errorMessage: "Not found" });
  }
}
