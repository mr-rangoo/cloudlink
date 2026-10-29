import net from "node:net";
import { encodeSentence, parseAttributes, SentenceReader } from "@/server/integrations/routeros/protocol";

/**
 * In-process fake RouterOS API server speaking the real wire protocol. It models the subset Cloudlink uses:
 * /login, /system/resource|identity print, /ppp/secret, /ppp/active, /ppp/profile, /ip/hotspot/user, /ip/hotspot/user/profile,
 * /ip/hotspot/active. Failure injection lets tests exercise timeouts, dropped connections and !trap errors.
 */
type Row = Record<string, string>;

export interface FakeRouterOptions {
  username?: string;
  password?: string;
}

export class FakeRouterOs {
  readonly tables: Record<string, Row[]> = { "/ppp/secret": [], "/ppp/active": [], "/ppp/profile": [], "/ip/hotspot/user": [], "/ip/hotspot/user/profile": [], "/ip/hotspot/active": [] };
  readonly log: string[][] = [];
  private nextId = 1;
  private server?: net.Server;
  failures: Array<{ match: string; kind: "drop" | "trap" | "hang"; message?: string }> = [];
  port = 0;

  constructor(private readonly opts: FakeRouterOptions = {}) {}

  async start(): Promise<number> {
    this.server = net.createServer((sock) => this.handle(sock));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  reset() {
    for (const key of Object.keys(this.tables)) this.tables[key] = [];
    this.failures = [];
    this.log.length = 0;
  }

  /** Commands received (first word of each sentence), for asserting what was sent. */
  commands(): string[] {
    return this.log.map((w) => w.join(" "));
  }

  /** Simulate a router-side session for a PPPoE user (as if the CPE dialled in). */
  addActivePppoe(name: string, address = "10.10.0.2") {
    this.tables["/ppp/active"]!.push({ ".id": `*${this.nextId++}`, name, address, "caller-id": "AA:BB:CC:00:00:01", uptime: "1h2m3s", service: "pppoe" });
  }

  private handle(sock: net.Socket) {
    const reader = new SentenceReader();
    let authed = false;
    sock.on("data", (chunk) => {
      for (const words of reader.push(chunk)) {
        this.log.push(words);
        const cmd = words[0] ?? "";
        const failure = this.failures.find((f) => cmd.startsWith(f.match));
        if (failure) {
          this.failures.splice(this.failures.indexOf(failure), 1);
          if (failure.kind === "drop") return void sock.destroy();
          if (failure.kind === "hang") return; // never answer → client timeout
          sock.write(encodeSentence(["!trap", `=message=${failure.message ?? "failure"}`]));
          sock.write(encodeSentence(["!done"]));
          continue;
        }
        const attrs = parseAttributes(words.slice(1));
        if (cmd === "/login") {
          if (attrs.name === (this.opts.username ?? "cloudlink") && attrs.password === (this.opts.password ?? "router-pass")) {
            authed = true;
            sock.write(encodeSentence(["!done"]));
          } else {
            sock.write(encodeSentence(["!trap", "=message=invalid user name or password (6)"]));
            sock.write(encodeSentence(["!done"]));
          }
          continue;
        }
        if (!authed) {
          sock.write(encodeSentence(["!fatal", "not logged in"]));
          sock.destroy();
          return;
        }
        this.exec(cmd, words.slice(1), attrs).forEach((s) => sock.write(encodeSentence(s)));
      }
    });
    sock.on("error", () => undefined);
  }

  private exec(cmd: string, words: string[], attrs: Row): string[][] {
    if (cmd === "/system/resource/print") return [["!re", "=version=7.14.3 (stable)", "=board-name=hEX S", "=uptime=3d4h", "=cpu-load=7"], ["!done"]];
    if (cmd === "/system/identity/print") return [["!re", "=name=FakeRouter"], ["!done"]];
    const slash = cmd.lastIndexOf("/");
    const path = cmd.slice(0, slash);
    const verb = cmd.slice(slash + 1);
    const table = this.tables[path];
    if (!table) return [["!trap", "=message=no such command prefix"], ["!done"]];
    const queries = words.filter((w) => w.startsWith("?")).map((w) => w.slice(1).split("=") as [string, string]);
    if (verb === "print") {
      const rows = table.filter((r) => queries.every(([k, v]) => r[k] === v));
      return [...rows.map((r) => ["!re", ...Object.entries(r).map(([k, v]) => `=${k}=${v}`)]), ["!done"]];
    }
    if (verb === "add") {
      if (attrs.name && table.some((r) => r.name === attrs.name)) return [["!trap", "=message=failure: secret with the same name already exists"], ["!done"]];
      const id = `*${this.nextId++}`;
      table.push({ ".id": id, disabled: "false", ...attrs });
      return [["!done", `=ret=${id}`]];
    }
    if (verb === "set") {
      const row = table.find((r) => r[".id"] === attrs[".id"]);
      if (!row) return [["!trap", "=message=no such item"], ["!done"]];
      Object.assign(row, Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== ".id")));
      return [["!done"]];
    }
    if (verb === "remove") {
      const i = table.findIndex((r) => r[".id"] === attrs[".id"]);
      if (i < 0) return [["!trap", "=message=no such item"], ["!done"]];
      table.splice(i, 1);
      return [["!done"]];
    }
    return [["!trap", `=message=unknown command ${verb}`], ["!done"]];
  }
}
