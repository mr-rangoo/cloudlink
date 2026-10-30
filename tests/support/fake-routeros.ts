import net from "node:net";
import { encodeSentence, parseAttributes, SentenceReader } from "@/server/integrations/routeros/protocol";

/**
 * In-process fake RouterOS API server speaking the real wire protocol. It models the subset Cloudlink uses:
 * /login, /system/resource|identity|health|clock|ntp, /system/reboot, /interface (print, monitor-traffic), /ppp/secret, /ppp/active,
 * /ppp/profile, /ip/hotspot (servers, profiles, users, walled garden, …), /tool/fetch, /file, /log, /radius, /ip/service.
 * Failure injection lets tests exercise timeouts, dropped connections and !trap errors.
 */
type Row = Record<string, string>;

export interface FakeRouterOptions {
  username?: string;
  password?: string;
}

export class FakeRouterOs {
  readonly tables: Record<string, Row[]> = {
    "/ppp/secret": [],
    "/ppp/active": [],
    "/ppp/profile": [],
    "/ip/hotspot/user": [],
    "/ip/hotspot/user/profile": [],
    "/ip/hotspot/active": [],
    "/ip/hotspot/cookie": [],
    "/ip/hotspot/ip-binding": [],
    "/ip/hotspot/host": [],
    "/ip/hotspot": [],
    "/ip/hotspot/profile": [],
    "/ip/hotspot/walled-garden": [],
    "/ip/hotspot/walled-garden/ip": [],
    "/interface": [],
    "/interface/pppoe-server/server": [],
    "/radius": [],
    "/ip/service": [],
    "/file": [],
    "/log": [],
  };
  identity = "FakeRouter";
  clock: Row = { "time-zone-name": "UTC", "time-zone-autodetect": "true" };
  ntp: Row = { enabled: "false" };
  reboots = 0;
  /** RouterOS 6 boards: no time-zone-autodetect, NTP takes server-dns-names. */
  v6 = false;
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
    this.identity = "FakeRouter";
    this.clock = { "time-zone-name": "UTC", "time-zone-autodetect": "true" };
    this.ntp = { enabled: "false" };
    this.reboots = 0;
    this.v6 = false;
  }

  /** Add a row to a table (servers, profiles, interfaces, log lines …) with a fresh .id. */
  seed(path: string, row: Row) {
    this.tables[path]!.push({ ".id": `*${this.nextId++}`, ...row });
  }

  /** Commands received (first word of each sentence), for asserting what was sent. */
  commands(): string[] {
    return this.log.map((w) => w.join(" "));
  }

  /** Simulate a logged-in hotspot device (session + login cookie). */
  addActiveHotspot(user: string, mac = "AA:BB:CC:00:00:09") {
    this.tables["/ip/hotspot/active"]!.push({ ".id": `*${this.nextId++}`, user, address: "10.5.50.9", "mac-address": mac, uptime: "5m", "bytes-in": "1000", "bytes-out": "9000" });
    this.tables["/ip/hotspot/cookie"]!.push({ ".id": `*${this.nextId++}`, user, "mac-address": mac });
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
        if (cmd === "/system/reboot") {
          // A real router drops the connection as it goes down, without answering.
          this.reboots++;
          return void sock.destroy();
        }
        this.exec(cmd, words.slice(1), attrs).forEach((s) => sock.write(encodeSentence(s)));
      }
    });
    sock.on("error", () => undefined);
  }

  private exec(cmd: string, words: string[], attrs: Row): string[][] {
    const row = (r: Row) => ["!re", ...Object.entries(r).map(([k, v]) => `=${k}=${v}`)];
    if (cmd === "/system/resource/print") {
      return [
        row({
          version: this.v6 ? "6.49.10 (long-term)" : "7.14.3 (stable)",
          "board-name": "hEX S",
          uptime: "3d4h",
          "cpu-load": "7",
          "free-memory": "201326592",
          "total-memory": "268435456",
          "free-hdd-space": "12582912",
          "total-hdd-space": "16777216",
        }),
        ["!done"],
      ];
    }
    if (cmd === "/system/identity/print") return [row({ name: this.identity }), ["!done"]];
    if (cmd === "/system/identity/set") {
      this.identity = attrs.name ?? this.identity;
      return [["!done"]];
    }
    if (cmd === "/system/health/print") return [row({ name: "temperature", value: "41", type: "C" }), ["!done"]];
    if (cmd === "/system/clock/print") return [row(this.clock), ["!done"]];
    if (cmd === "/system/clock/set") {
      if (this.v6 && "time-zone-autodetect" in attrs) return [["!trap", "=message=unknown parameter time-zone-autodetect"], ["!done"]];
      Object.assign(this.clock, attrs);
      return [["!done"]];
    }
    if (cmd === "/system/ntp/client/print") return [row(this.ntp), ["!done"]];
    if (cmd === "/system/ntp/client/set") {
      if (this.v6 && "servers" in attrs) return [["!trap", "=message=unknown parameter servers"], ["!done"]];
      Object.assign(this.ntp, attrs);
      return [["!done"]];
    }
    if (cmd === "/interface/monitor-traffic") {
      if (!this.tables["/interface"]!.some((r) => r.name === attrs.interface)) return [["!trap", "=message=no such item"], ["!done"]];
      return [row({ name: attrs.interface!, "rx-bits-per-second": "18500000", "tx-bits-per-second": "2400000" }), ["!done"]];
    }
    if (cmd === "/tool/fetch") {
      this.seed("/file", { name: attrs["dst-path"] ?? "fetched", type: ".html file", contents: `(fetched from ${attrs.url})` });
      return [row({ status: "finished" }), ["!done"]];
    }
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
    if (verb === "reset-counters") {
      const row = table.find((r) => r[".id"] === attrs[".id"]);
      if (!row) return [["!trap", "=message=no such item"], ["!done"]];
      Object.assign(row, { "bytes-in": "0", "bytes-out": "0", "counters-reset": String(Number(row["counters-reset"] ?? 0) + 1) });
      return [["!done"]];
    }
    return [["!trap", `=message=unknown command ${verb}`], ["!done"]];
  }
}
