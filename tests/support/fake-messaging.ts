import http from "node:http";
import net from "node:net";

/**
 * Local fakes for messaging providers:
 * - FakeSmsApi speaks the subset of the Africa's Talking and Twilio HTTP APIs Cloudlink uses (send + balance).
 * - FakeSmtp is a minimal SMTP server (EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT) without TLS.
 */
export interface SmsRequest {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  form: Record<string, string>;
}

export class FakeSmsApi {
  readonly requests: SmsRequest[] = [];
  /** Respond with this status to the next send (e.g. 401 to simulate a rejected key). */
  failNext: number | null = null;
  apiKey = "at-test-key-123456";
  twilio = { sid: `AC${"1".repeat(32)}`, token: "twilio-test-token-1234" };
  private server?: http.Server;
  port = 0;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://fake");
        const form = Object.fromEntries(new URLSearchParams(body));
        this.requests.push({ path: url.pathname, method: req.method ?? "GET", headers: req.headers, form });
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        if (url.pathname === "/version1/messaging") {
          if (this.failNext) return json(this.consumeFailure(), { error: "rejected" });
          if (req.headers.apikey !== this.apiKey) return json(401, { error: "The supplied authentication is invalid" });
          return json(201, { SMSMessageData: { Message: "Sent to 1/1", Recipients: [{ statusCode: 101, number: form.to, status: "Success", messageId: `ATXid_${this.requests.length}` }] } });
        }
        if (url.pathname === "/version1/user") {
          if (req.headers.apikey !== this.apiKey) return json(401, { error: "invalid" });
          return json(200, { UserData: { balance: "KES 1234.5000" } });
        }
        const auth = `Basic ${Buffer.from(`${this.twilio.sid}:${this.twilio.token}`).toString("base64")}`;
        if (url.pathname === `/2010-04-01/Accounts/${this.twilio.sid}/Messages.json`) {
          if (this.failNext) return json(this.consumeFailure(), { code: 21211, message: "Invalid 'To' Phone Number" });
          if (req.headers.authorization !== auth) return json(401, { code: 20003, message: "Authenticate" });
          return json(201, { sid: `SM${String(this.requests.length).padStart(32, "0")}`, status: "queued" });
        }
        if (url.pathname === `/2010-04-01/Accounts/${this.twilio.sid}/Balance.json`) {
          if (req.headers.authorization !== auth) return json(401, { code: 20003, message: "Authenticate" });
          return json(200, { balance: "12.34", currency: "usd", account_sid: this.twilio.sid });
        }
        json(404, { error: "not found" });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  private consumeFailure(): number {
    const s = this.failNext!;
    this.failNext = null;
    return s;
  }

  sends() {
    return this.requests.filter((r) => r.method === "POST");
  }

  reset() {
    this.requests.length = 0;
    this.failNext = null;
  }

  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}

export interface SmtpMessage {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

export class FakeSmtp {
  readonly messages: SmtpMessage[] = [];
  private server?: net.Server;
  port = 0;

  async start(): Promise<number> {
    this.server = net.createServer((sock) => {
      let buffer = "";
      let inData = false;
      let current: SmtpMessage = { from: "", to: [], data: "", auth: null };
      const reply = (line: string) => sock.write(`${line}\r\n`);
      reply("220 fake.smtp ESMTP");
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            current.data = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            this.messages.push(current);
            current = { from: "", to: [], data: "", auth: current.auth };
            reply("250 OK queued");
            continue;
          }
          const nl = buffer.indexOf("\r\n");
          if (nl < 0) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const verb = line.split(" ")[0]!.toUpperCase();
          if (verb === "EHLO" || verb === "HELO") {
            sock.write("250-fake.smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
          } else if (verb === "AUTH") {
            current.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
            reply("235 Authentication successful");
          } else if (verb === "MAIL") {
            current.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0] ?? "";
            reply("250 OK");
          } else if (verb === "RCPT") {
            current.to.push(line.slice(8).replace(/[<>]/g, ""));
            reply("250 OK");
          } else if (verb === "DATA") {
            inData = true;
            reply("354 End data with <CR><LF>.<CR><LF>");
          } else if (verb === "QUIT") {
            reply("221 Bye");
            sock.end();
            return;
          } else {
            reply("250 OK");
          }
        }
      });
      sock.on("error", () => undefined);
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}
