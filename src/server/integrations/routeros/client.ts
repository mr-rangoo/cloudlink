import "server-only";
import net from "node:net";
import tls from "node:tls";
import { encodeSentence, parseAttributes, SentenceReader } from "@/server/integrations/routeros/protocol";

/**
 * Minimal RouterOS API client: one command at a time, explicit timeouts, post-6.43 login (/login with name+password).
 * Tested against an in-process fake RouterOS API server (tests/support/fake-routeros.ts).
 * Supported RouterOS versions: 6.43+ and 7.x (older challenge-response login is not supported).
 */
export class RouterOsTrapError extends Error {
  constructor(
    message: string,
    public readonly category?: string,
  ) {
    super(message);
    this.name = "RouterOsTrapError";
  }
}

export class RouterOsConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: "TIMEOUT" | "REFUSED" | "UNREACHABLE" | "CLOSED" | "FATAL" | "TLS",
  ) {
    super(message);
    this.name = "RouterOsConnectionError";
  }
}

export interface RouterOsConnectOptions {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
  timeoutMs?: number;
  /** TLS verification: RouterOS commonly uses self-signed certificates on private networks. */
  rejectUnauthorized?: boolean;
}

export class RouterOsClient {
  private socket?: net.Socket;
  private reader = new SentenceReader();
  private pending: Array<{ resolve: (s: string[]) => void; reject: (e: Error) => void }> = [];
  private queue: string[][] = [];
  private closedError?: Error;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RouterOsConnectOptions) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        const code = err.code === "ECONNREFUSED" ? "REFUSED" : err.code === "ETIMEDOUT" ? "TIMEOUT" : err.code?.startsWith("ERR_TLS") || err.code === "EPROTO" ? "TLS" : "UNREACHABLE";
        reject(new RouterOsConnectionError(`Cannot connect to router (${err.code ?? "error"})`, code));
      };
      const socket = this.opts.useTls
        ? tls.connect({ host: this.opts.host, port: this.opts.port, rejectUnauthorized: this.opts.rejectUnauthorized ?? false, timeout: this.timeoutMs }, () => resolve())
        : net.connect({ host: this.opts.host, port: this.opts.port, timeout: this.timeoutMs }, () => resolve());
      socket.once("error", onError);
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        reject(new RouterOsConnectionError("Router did not respond in time", "TIMEOUT"));
      });
      this.socket = socket;
    });
    const socket = this.socket!;
    socket.removeAllListeners("error");
    socket.on("data", (chunk: Buffer) => {
      for (const s of this.reader.push(chunk)) {
        const p = this.pending.shift();
        if (p) p.resolve(s);
        else this.queue.push(s);
      }
    });
    const fail = (err: Error) => {
      this.closedError = err;
      for (const p of this.pending.splice(0)) p.reject(err);
    };
    socket.on("error", () => fail(new RouterOsConnectionError("Connection error", "CLOSED")));
    socket.on("close", () => fail(new RouterOsConnectionError("Connection closed by router", "CLOSED")));
    await this.command(["/login", `=name=${this.opts.username}`, `=password=${this.opts.password}`]).catch((err) => {
      this.close();
      if (err instanceof RouterOsTrapError) throw new RouterOsTrapError("Router rejected the login credentials", "auth");
      throw err;
    });
  }

  private nextSentence(): Promise<string[]> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.resolve === wrapped);
        if (i >= 0) this.pending.splice(i, 1);
        this.socket?.destroy();
        reject(new RouterOsConnectionError("Router did not answer in time", "TIMEOUT"));
      }, this.timeoutMs);
      const wrapped = (s: string[]) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.pending.push({
        resolve: wrapped,
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Run one command; resolves with the !re rows, rejects on !trap / !fatal / timeout. */
  async command(words: string[]): Promise<Array<Record<string, string>>> {
    if (!this.socket || this.closedError) throw this.closedError ?? new RouterOsConnectionError("Not connected", "CLOSED");
    this.socket.write(encodeSentence(words));
    const rows: Array<Record<string, string>> = [];
    let trap: RouterOsTrapError | undefined;
    for (;;) {
      const s = await this.nextSentence();
      const kind = s[0];
      const attrs = parseAttributes(s.slice(1));
      if (kind === "!re") rows.push(attrs);
      else if (kind === "!trap") trap = new RouterOsTrapError(attrs.message ?? "Router returned an error", attrs.category);
      else if (kind === "!fatal") throw new RouterOsConnectionError(`Router closed the session: ${s[1] ?? ""}`, "FATAL");
      else if (kind === "!done") {
        if (trap) throw trap;
        return rows;
      }
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}

/** Open, run, always close. */
export async function withRouter<T>(opts: RouterOsConnectOptions, fn: (c: RouterOsClient) => Promise<T>): Promise<T> {
  const client = new RouterOsClient(opts);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
