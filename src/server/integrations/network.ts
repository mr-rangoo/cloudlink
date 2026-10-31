import "server-only";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { RouterOsConnectionError, RouterOsTrapError, withRouter, type RouterOsClient } from "@/server/integrations/routeros/client";
import { attr, query, RouterOsInputError } from "@/server/integrations/routeros/protocol";
import { formatRate } from "@/lib/plans";

/**
 * Network adapter boundary (server-side only, worker process). Business code never talks to routers directly and
 * never accepts arbitrary commands: only the operations below exist.
 *
 * - mock: deterministic and changes nothing; results are SIMULATED. Failure injection for tests and demos:
 *   a router whose name contains "[flaky]" fails attempt 1 of every operation with a timeout; "[offline]" always
 *   times out; "[reject]" fails permanently as if the router refused the change.
 * - routeros: real RouterOS API (TCP 8728 / TLS 8729), see routeros/client.ts. Every write is read back.
 * - disabled: every operation fails with a clear reason.
 */
export interface RouterTarget {
  id: string;
  name: string;
  host: string;
  apiPort: number;
  useTls: boolean;
  username: string;
  password: string;
}

export interface ExecContext {
  /** 1-based attempt number of the durable network operation (drives deterministic mock failures). */
  attempt: number;
}

export interface PppoeSecret {
  username: string;
  password: string;
  profile: string;
  /** Disabled secrets also have their active sessions disconnected. */
  disabled: boolean;
  comment?: string;
}

export interface HotspotUser {
  username: string;
  password: string;
  profile: string;
  uptimeLimitSeconds: number;
  macAddress: string | null;
  comment?: string;
}

/** A hotspot subscription's login on the router (created, updated, or disabled with its sessions and cookies removed). */
export interface HotspotAccess {
  username: string;
  password: string;
  profile: string;
  disabled: boolean;
  /** Router-side backstop for the paid period (Cloudlink disables the user at the period end). */
  uptimeLimitSeconds: number | null;
  /** Data bundles: total bytes allowed in the period. */
  limitBytesTotal: number | null;
  /** New period of a data bundle: start counting usage again. */
  resetCounters: boolean;
  comment?: string;
}

/** A device (TV, streaming box) let through the hotspot by MAC address, without a login page. */
export interface DeviceBinding {
  macAddress: string;
  enabled: boolean;
  comment: string;
}

/** A plan's speed settings as a RouterOS PPP profile or hotspot user profile (created or updated by name). */
export interface ServiceProfile {
  kind: "PPPOE" | "HOTSPOT";
  name: string;
  /** RouterOS rate-limit ("rx/tx [burst …]"); null leaves the profile's current limit untouched. */
  rateLimit: string | null;
  /** Hotspot only: simultaneous logins per account (shared-users). */
  sharedUsers: number | null;
  comment?: string;
  /** PPPoE only, on routers running Cloudlink's PPPoE server: addressing from the link wizard (router address and pool). */
  addressing?: { localAddress: string; remotePool: string } | null;
}

/** RouterOS prints burst times with a unit ("30s/30s"); compare limits without it. */
export function normalizeRateLimit(v: string | undefined | null): string {
  return (v ?? "")
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/(\d+)s(?=\/|$)/g, "$1"))
    .join(" ");
}

export interface OpResult {
  status: "SUCCEEDED" | "SIMULATED";
  /** true = read back and matched; false = read back and did NOT match; null = verification not supported. */
  verified: boolean | null;
  detail: string;
  snapshot?: OpSnapshot;
}

export interface RouterHealth {
  online: boolean;
  simulated?: boolean;
  identity?: string;
  version?: string;
  board?: string;
  metrics?: RouterMetrics;
  detail: string;
}

/** Resources read during a health check. Every field is optional: older boards do not report all of them. */
export interface RouterMetrics {
  cpuLoad?: number;
  memoryUsedPct?: number;
  diskUsedPct?: number;
  temperatureC?: number;
  uptimeSeconds?: number;
  /** Uplink traffic in bits per second, from the router's point of view (rx = received). */
  rxBps?: bigint;
  txBps?: bigint;
  interfaceName?: string;
}

/** What a diagnosis checks against (the organization's expectations for this router). */
export interface DiagnosisContext {
  pppoe: boolean;
  hotspot: boolean;
  radiusAddress: string | null;
  walledGardenHost: string | null;
  timezone: string;
  /** Router profiles Cloudlink's plans use on this router. */
  profiles: Array<{ name: string; kind: "PPPOE" | "HOTSPOT" }>;
}

export interface DiagnosisCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "problem" | "skipped";
  detail: string;
}

export interface LogLine {
  time: string;
  topics: string;
  message: string;
}

/** Read-only results some operations bring back (stored as router snapshots). */
export type OpSnapshot = { kind: "diagnosis"; data: { checks: DiagnosisCheck[] } } | { kind: "logs"; data: { lines: LogLine[] } };

export interface ActiveSession {
  /** BINDING = a device let through by MAC (no login), seen in the hotspot host table. */
  kind: "PPPOE" | "HOTSPOT" | "BINDING";
  externalId: string;
  username: string;
  address?: string;
  macAddress?: string;
  uptimeSeconds?: number;
  bytesIn?: bigint;
  bytesOut?: bigint;
  startedAt?: Date;
}

/**
 * Who the billing system believes is enabled on a router. Real adapters ignore it (they report what the router
 * says); the mock adapter uses it to simulate sessions so live views can be exercised without hardware.
 */
export interface SessionHint {
  pppoe: string[];
  hotspot: Array<{ id: string; username: string; macAddress: string | null; address: string | null; since: Date; until: Date }>;
  bindings?: Array<{ id: string; macAddress: string; since: Date; until: Date }>;
}

export interface NetworkAdapter {
  name: "mock" | "routeros" | "disabled";
  upsertPppoeSecret(r: RouterTarget, s: PppoeSecret, x: ExecContext): Promise<OpResult>;
  removePppoeSecret(r: RouterTarget, username: string, x: ExecContext): Promise<OpResult>;
  upsertHotspotUser(r: RouterTarget, u: HotspotUser, x: ExecContext): Promise<OpResult>;
  disconnectSession(r: RouterTarget, kind: "PPPOE" | "HOTSPOT", username: string, x: ExecContext): Promise<OpResult>;
  upsertProfile(r: RouterTarget, p: ServiceProfile, x: ExecContext): Promise<OpResult>;
  setHotspotAccess(r: RouterTarget, a: HotspotAccess, x: ExecContext): Promise<OpResult>;
  setDeviceBinding(r: RouterTarget, b: DeviceBinding, x: ExecContext): Promise<OpResult>;
  health(r: RouterTarget, opts?: { uplinkInterface?: string | null }): Promise<RouterHealth>;
  listSessions(r: RouterTarget, hint?: SessionHint): Promise<ActiveSession[]>;
  /** Restart the router. The connection drops as the router goes down, which counts as sent (not verifiable). */
  reboot(r: RouterTarget, x: ExecContext): Promise<OpResult>;
  setIdentity(r: RouterTarget, name: string, x: ExecContext): Promise<OpResult>;
  /** Time zone and NTP client, so logs, schedules and expiries line up. */
  syncClock(r: RouterTarget, timezone: string, x: ExecContext): Promise<OpResult>;
  /** Let devices reach Cloudlink's captive portal before logging in (HTTP and HTTPS entries). */
  syncWalledGarden(r: RouterTarget, host: string, x: ExecContext): Promise<OpResult>;
  /** Download Cloudlink's login page into every hotspot profile's directory and allow PAP login. */
  installLoginPage(r: RouterTarget, url: string, x: ExecContext): Promise<OpResult>;
  diagnose(r: RouterTarget, ctx: DiagnosisContext): Promise<DiagnosisCheck[]>;
  readLogs(r: RouterTarget, limit: number): Promise<LogLine[]>;
}

// ───────── Error classification ─────────

/** Map adapter errors to the retry policy: connection problems are retryable, router rejections are permanent. */
export function classify(err: unknown): never {
  if (err instanceof RetryableError || err instanceof PermanentError) throw err;
  if (err instanceof RouterOsInputError) throw new PermanentError(err.message, "INVALID_INPUT");
  if (err instanceof RouterOsConnectionError) throw new RetryableError(err.message, `ROUTER_${err.code}`);
  if (err instanceof RouterOsTrapError) {
    if (err.category === "auth") throw new PermanentError(err.message, "ROUTER_AUTH");
    throw new PermanentError(`Router rejected the operation: ${err.message}`, "ROUTER_TRAP");
  }
  throw new RetryableError("Unexpected network error", "NETWORK_UNEXPECTED");
}

// ───────── Mock ─────────

class MockNetworkAdapter implements NetworkAdapter {
  name = "mock" as const;
  private gate(r: RouterTarget, x: ExecContext) {
    if (r.name.includes("[offline]")) throw new RetryableError("Mock router is offline (simulated timeout)", "ROUTER_TIMEOUT");
    if (r.name.includes("[reject]")) throw new PermanentError("Mock router rejected the change (simulated)", "ROUTER_TRAP");
    if (r.name.includes("[flaky]") && x.attempt === 1) throw new RetryableError("Mock router timed out on the first attempt (simulated)", "ROUTER_TIMEOUT");
  }
  private sim(detail: string): OpResult {
    return { status: "SIMULATED", verified: null, detail: `Mock adapter: ${detail}. No router was changed.` };
  }
  async upsertPppoeSecret(r: RouterTarget, s: PppoeSecret, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`PPPoE secret ${s.username} would be ${s.disabled ? "disabled and its sessions disconnected" : "enabled"} with profile ${s.profile}`);
  }
  async removePppoeSecret(r: RouterTarget, username: string, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`PPPoE secret ${username} would be removed`);
  }
  async upsertHotspotUser(r: RouterTarget, u: HotspotUser, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`hotspot user ${u.username.slice(0, 2)}*** would be created with profile ${u.profile}`);
  }
  async disconnectSession(r: RouterTarget, kind: string, username: string, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`${kind} session for ${username} would be disconnected`);
  }
  async upsertProfile(r: RouterTarget, p: ServiceProfile, x: ExecContext) {
    this.gate(r, x);
    const what = [p.rateLimit ? `rate-limit ${p.rateLimit}` : null, p.kind === "HOTSPOT" && p.sharedUsers ? `shared-users ${p.sharedUsers}` : null].filter(Boolean).join(", ");
    return this.sim(`${p.kind === "PPPOE" ? "PPP" : "hotspot user"} profile ${p.name} would be set${what ? ` (${what})` : ""}`);
  }
  async setHotspotAccess(r: RouterTarget, a: HotspotAccess, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`hotspot user ${a.username} would be ${a.disabled ? "disabled and logged out" : `enabled with profile ${a.profile}`}`);
  }
  async setDeviceBinding(r: RouterTarget, b: DeviceBinding, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`device ${b.macAddress} would be ${b.enabled ? "let through without a login" : "removed from the bypass list"}`);
  }
  async health(r: RouterTarget): Promise<RouterHealth> {
    if (r.name.includes("[offline]")) return { online: false, simulated: true, detail: "Mock router is offline (simulated)" };
    return { online: true, simulated: true, metrics: simulatedMetrics(r.id, new Date()), detail: "Mock adapter: simulated health check. No router was contacted." };
  }
  async reboot(r: RouterTarget, x: ExecContext) {
    this.gate(r, x);
    return this.sim("the router would restart");
  }
  async setIdentity(r: RouterTarget, name: string, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`the router identity would be set to ${name}`);
  }
  async syncClock(r: RouterTarget, timezone: string, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`the time zone would be set to ${timezone} with NTP enabled`);
  }
  async syncWalledGarden(r: RouterTarget, host: string, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`${host} would be allowed before login (HTTP and HTTPS)`);
  }
  async installLoginPage(r: RouterTarget, url: string, x: ExecContext) {
    this.gate(r, x);
    return this.sim(`the hotspot login page would be downloaded from ${new URL(url).host}`);
  }
  async diagnose(r: RouterTarget, ctx: DiagnosisContext): Promise<DiagnosisCheck[]> {
    if (r.name.includes("[offline]")) throw new RetryableError("Mock router is offline (simulated timeout)", "ROUTER_TIMEOUT");
    // Nothing is checked, so nothing is reported as passing: every check is "skipped" with what it would compare.
    const sim = "Not checked: the mock adapter does not contact routers.";
    return [
      { id: "api", label: "API login", status: "skipped", detail: sim },
      { id: "clock", label: "Clock and time zone", status: "skipped", detail: `Would expect ${ctx.timezone}. ${sim}` },
      { id: "pppoe", label: "PPPoE server", status: "skipped", detail: ctx.pppoe ? sim : "PPPoE is not used on this router." },
      { id: "hotspot", label: "Hotspot server", status: "skipped", detail: ctx.hotspot ? sim : "The hotspot is not used on this router." },
      { id: "profiles", label: "Plan profiles", status: "skipped", detail: `${ctx.profiles.length} profile(s) expected. ${sim}` },
    ];
  }
  async readLogs(r: RouterTarget, limit: number): Promise<LogLine[]> {
    if (r.name.includes("[offline]")) throw new RetryableError("Mock router is offline (simulated timeout)", "ROUTER_TIMEOUT");
    const now = new Date();
    return [
      { time: now.toISOString(), topics: "system,info", message: "Simulated log line: the mock adapter does not read router logs." },
      { time: new Date(now.getTime() - 60_000).toISOString(), topics: "hotspot,info", message: "Simulated: a device logged in." },
    ].slice(0, limit);
  }
  async listSessions(r: RouterTarget, hint?: SessionHint): Promise<ActiveSession[]> {
    if (r.name.includes("[offline]")) throw new RetryableError("Mock router is offline (simulated timeout)", "ROUTER_TIMEOUT");
    return hint ? simulatedSessions(hint, new Date()) : [];
  }
}

/**
 * Deterministic resource readings for the mock adapter (same router and minute → same values), so charts and the
 * health score can be exercised without hardware. Samples taken this way are stored as simulated.
 */
export function simulatedMetrics(routerId: string, now: Date): RouterMetrics {
  const h = fnv1a(routerId);
  const t = now.getTime() / 1000;
  const wave = (period: number, phase: number) => 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / period + phase);
  const evening = wave(86_400, (h % 628) / 100);
  return {
    cpuLoad: Math.round(8 + 45 * evening * wave(1800, h % 7)),
    memoryUsedPct: Math.round(40 + 25 * evening),
    diskUsedPct: 30 + (h % 25),
    temperatureC: Math.round(380 + 80 * evening) / 10,
    uptimeSeconds: Math.floor(t - (h % 2_000_000)) % 2_592_000,
    rxBps: BigInt(Math.round(2_000_000 + 38_000_000 * evening * wave(900, h % 5))),
    txBps: BigInt(Math.round(400_000 + 6_000_000 * evening * wave(1100, h % 3))),
    interfaceName: "ether1",
  };
}

/** Simulated PPPoE users reconnect every three days, so uptime grows and resets like a real line. */
const SIM_CYCLE_SECONDS = 3 * 24 * 3600;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic fake sessions for the mock adapter (same input and time → same output). Addresses come from
 * 10.64.0.0/10 and MACs are locally administered, so they cannot be mistaken for real equipment.
 */
export function simulatedSessions(hint: SessionHint, now: Date): ActiveSession[] {
  const t = Math.floor(now.getTime() / 1000);
  const mac = (h: number) => ["02", ...[h >>> 24, h >>> 16, h >>> 8, h, h >>> 4].map((b) => (b & 0xff).toString(16).padStart(2, "0"))].join(":").toUpperCase();
  const pppoe = hint.pppoe.map((username): ActiveSession => {
    const h = fnv1a(username);
    const uptime = (((t - (h % SIM_CYCLE_SECONDS)) % SIM_CYCLE_SECONDS) + SIM_CYCLE_SECONDS) % SIM_CYCLE_SECONDS;
    const started = t - uptime;
    const down = 20_000 + (h % 180_000); // average bytes per second towards the customer
    return {
      kind: "PPPOE",
      externalId: `*sim-${h.toString(16)}-${started}`,
      username,
      address: `10.${64 + (h % 64)}.${(h >>> 8) & 0xff}.${2 + ((h >>> 16) % 250)}`,
      macAddress: mac(h),
      uptimeSeconds: uptime,
      bytesIn: BigInt(uptime * Math.floor(down / 8)),
      bytesOut: BigInt(uptime * down),
      startedAt: new Date(started * 1000),
    };
  });
  const hotspot = hint.hotspot
    .filter((u) => u.since <= now && u.until > now)
    .map((u): ActiveSession => {
      const h = fnv1a(u.id);
      const uptime = Math.max(0, t - Math.floor(u.since.getTime() / 1000));
      const down = 10_000 + (h % 90_000);
      return {
        kind: "HOTSPOT",
        externalId: `*sim-hs-${h.toString(16)}`,
        username: u.username,
        address: u.address ?? `10.${64 + (h % 64)}.${(h >>> 8) & 0xff}.${2 + ((h >>> 16) % 250)}`,
        macAddress: u.macAddress ?? mac(h),
        uptimeSeconds: uptime,
        bytesIn: BigInt(uptime * Math.floor(down / 8)),
        bytesOut: BigInt(uptime * down),
        startedAt: u.since,
      };
    });
  const bindings = (hint.bindings ?? [])
    .filter((b) => b.since <= now && b.until > now)
    .map((b): ActiveSession => {
      const h = fnv1a(b.id);
      const uptime = Math.max(0, t - Math.floor(b.since.getTime() / 1000));
      const down = 40_000 + (h % 200_000);
      return {
        kind: "BINDING",
        externalId: `*sim-bind-${h.toString(16)}`,
        username: b.macAddress,
        address: `10.${64 + (h % 64)}.${(h >>> 8) & 0xff}.${2 + ((h >>> 16) % 250)}`,
        macAddress: b.macAddress,
        uptimeSeconds: uptime,
        bytesIn: BigInt(uptime * Math.floor(down / 10)),
        bytesOut: BigInt(uptime * down),
        startedAt: b.since,
      };
    });
  return [...pppoe, ...hotspot, ...bindings];
}

// ───────── RouterOS ─────────

function rosOpts(r: RouterTarget) {
  return { host: r.host, port: r.apiPort, useTls: r.useTls, username: r.username, password: r.password, timeoutMs: Number(process.env.ROUTEROS_TIMEOUT_MS || 8000) };
}

export function parseUptime(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return undefined;
  const [w, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  return w * 604800 + d * 86400 + h * 3600 + mi * 60 + s;
}

/** RouterOS byte counter ("123456") → bigint; anything else is treated as unknown. */
export function counter(v: string | undefined): bigint | undefined {
  return v && /^\d{1,20}$/.test(v) ? BigInt(v) : undefined;
}

export function rosDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const out = `${d ? `${d}d` : ""}${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}`;
  return out || "0s";
}

const yes = (v: string | undefined) => v === "true" || v === "yes";

function intOf(v: string | undefined): number | undefined {
  return v && /^\d{1,6}$/.test(v) ? Number(v) : undefined;
}

/** Percentage used from RouterOS free/total readings (bytes); undefined when either is missing. */
export function usedPct(free: string | undefined, total: string | undefined): number | undefined {
  const f = Number(free);
  const t = Number(total);
  if (!free || !total || !Number.isFinite(f) || !Number.isFinite(t) || t <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round(((t - f) / t) * 100)));
}

async function findByName(c: RouterOsClient, path: string, name: string) {
  const rows = await c.command([`${path}/print`, query("name", name)]);
  return rows[0];
}

async function disconnectAll(c: RouterOsClient, path: string, key: string, username: string): Promise<number> {
  const rows = await c.command([`${path}/print`, query(key, username)]);
  for (const a of rows) await c.command([`${path}/remove`, attr(".id", a[".id"]!)]);
  return rows.length;
}

class RouterOsAdapter implements NetworkAdapter {
  name = "routeros" as const;

  async upsertPppoeSecret(r: RouterTarget, s: PppoeSecret): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const existing = await findByName(c, "/ppp/secret", s.username);
        const fields = [
          attr("password", s.password),
          attr("profile", s.profile),
          attr("service", "pppoe"),
          attr("disabled", s.disabled ? "yes" : "no"),
          ...(s.comment ? [attr("comment", s.comment)] : []),
        ];
        if (existing) await c.command(["/ppp/secret/set", attr(".id", existing[".id"]!), ...fields]);
        else await c.command(["/ppp/secret/add", attr("name", s.username), ...fields]);
        const kicked = s.disabled ? await disconnectAll(c, "/ppp/active", "name", s.username) : 0;
        const check = await findByName(c, "/ppp/secret", s.username);
        const verified = Boolean(check) && check!.profile === s.profile && yes(check!.disabled) === s.disabled;
        const action = existing ? "updated" : "created";
        return {
          status: "SUCCEEDED" as const,
          verified,
          detail: `PPPoE secret ${s.username} ${action} and ${s.disabled ? "disabled" : "enabled"}${kicked ? `; ${kicked} active session(s) disconnected` : ""}`,
        };
      });
    } catch (err) {
      classify(err);
    }
  }

  async removePppoeSecret(r: RouterTarget, username: string): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const existing = await findByName(c, "/ppp/secret", username);
        if (existing) await c.command(["/ppp/secret/remove", attr(".id", existing[".id"]!)]);
        const kicked = await disconnectAll(c, "/ppp/active", "name", username);
        const check = await findByName(c, "/ppp/secret", username);
        return {
          status: "SUCCEEDED" as const,
          verified: !check,
          detail: `${existing ? `PPPoE secret ${username} removed` : `PPPoE secret ${username} was already absent`}${kicked ? `; ${kicked} session(s) disconnected` : ""}`,
        };
      });
    } catch (err) {
      classify(err);
    }
  }

  async upsertHotspotUser(r: RouterTarget, u: HotspotUser): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const existing = await findByName(c, "/ip/hotspot/user", u.username);
        const fields = [
          attr("password", u.password),
          attr("profile", u.profile),
          attr("limit-uptime", rosDuration(u.uptimeLimitSeconds)),
          ...(u.macAddress ? [attr("mac-address", u.macAddress)] : []),
          ...(u.comment ? [attr("comment", u.comment)] : []),
        ];
        if (existing) await c.command(["/ip/hotspot/user/set", attr(".id", existing[".id"]!), ...fields]);
        else await c.command(["/ip/hotspot/user/add", attr("name", u.username), ...fields]);
        const check = await findByName(c, "/ip/hotspot/user", u.username);
        return { status: "SUCCEEDED" as const, verified: Boolean(check) && check!.profile === u.profile, detail: `Hotspot user ${u.username.slice(0, 2)}*** ${existing ? "updated" : "created"}` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async disconnectSession(r: RouterTarget, kind: "PPPOE" | "HOTSPOT", username: string): Promise<OpResult> {
    const path = kind === "PPPOE" ? "/ppp/active" : "/ip/hotspot/active";
    const key = kind === "PPPOE" ? "name" : "user";
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const n = await disconnectAll(c, path, key, username);
        const left = await c.command([`${path}/print`, query(key, username)]);
        return { status: "SUCCEEDED" as const, verified: left.length === 0, detail: n ? `${n} session(s) for ${username} disconnected` : `No active session for ${username}` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async upsertProfile(r: RouterTarget, p: ServiceProfile): Promise<OpResult> {
    const path = p.kind === "PPPOE" ? "/ppp/profile" : "/ip/hotspot/user/profile";
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const existing = await findByName(c, path, p.name);
        const fields = [
          ...(p.rateLimit ? [attr("rate-limit", p.rateLimit)] : []),
          ...(p.kind === "HOTSPOT" && p.sharedUsers ? [attr("shared-users", String(p.sharedUsers))] : []),
          ...(p.comment && p.kind === "PPPOE" ? [attr("comment", p.comment)] : []),
          ...(p.kind === "PPPOE" && p.addressing
            ? [attr("local-address", p.addressing.localAddress), attr("remote-address", p.addressing.remotePool), attr("dns-server", p.addressing.localAddress)]
            : []),
        ];
        if (existing) {
          if (fields.length) await c.command([`${path}/set`, attr(".id", existing[".id"]!), ...fields]);
        } else {
          await c.command([`${path}/add`, attr("name", p.name), ...fields]);
        }
        const check = await findByName(c, path, p.name);
        const rateOk = !p.rateLimit || normalizeRateLimit(check?.["rate-limit"]) === normalizeRateLimit(p.rateLimit);
        const sharedOk = p.kind !== "HOTSPOT" || !p.sharedUsers || check?.["shared-users"] === String(p.sharedUsers);
        return {
          status: "SUCCEEDED" as const,
          verified: Boolean(check) && rateOk && sharedOk,
          detail: `${p.kind === "PPPOE" ? "PPP" : "Hotspot user"} profile ${p.name} ${existing ? "updated" : "created"}${p.rateLimit ? ` (rate-limit ${p.rateLimit})` : ""}`,
        };
      });
    } catch (err) {
      classify(err);
    }
  }

  async setHotspotAccess(r: RouterTarget, a: HotspotAccess): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const existing = await findByName(c, "/ip/hotspot/user", a.username);
        const fields = [
          attr("password", a.password),
          attr("profile", a.profile),
          attr("disabled", a.disabled ? "yes" : "no"),
          attr("limit-uptime", a.uptimeLimitSeconds ? rosDuration(a.uptimeLimitSeconds) : "0s"),
          attr("limit-bytes-total", String(a.limitBytesTotal ?? 0)),
          ...(a.comment ? [attr("comment", a.comment)] : []),
        ];
        if (existing) await c.command(["/ip/hotspot/user/set", attr(".id", existing[".id"]!), ...fields]);
        else await c.command(["/ip/hotspot/user/add", attr("name", a.username), ...fields]);
        if (a.resetCounters && existing) await c.command(["/ip/hotspot/user/reset-counters", attr(".id", existing[".id"]!)]);
        // Logging out also clears login cookies, so the device cannot reconnect silently.
        const kicked = a.disabled ? await disconnectAll(c, "/ip/hotspot/active", "user", a.username) : 0;
        if (a.disabled) await disconnectAll(c, "/ip/hotspot/cookie", "user", a.username);
        const check = await findByName(c, "/ip/hotspot/user", a.username);
        return {
          status: "SUCCEEDED" as const,
          verified: Boolean(check) && check!.profile === a.profile && yes(check!.disabled) === a.disabled,
          detail: `Hotspot user ${a.username} ${existing ? "updated" : "created"} and ${a.disabled ? "disabled" : "enabled"}${kicked ? `; ${kicked} session(s) logged out` : ""}`,
        };
      });
    } catch (err) {
      classify(err);
    }
  }

  async setDeviceBinding(r: RouterTarget, b: DeviceBinding): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const rows = await c.command(["/ip/hotspot/ip-binding/print", query("mac-address", b.macAddress)]);
        if (b.enabled) {
          if (rows[0]) await c.command(["/ip/hotspot/ip-binding/set", attr(".id", rows[0][".id"]!), attr("type", "bypassed"), attr("disabled", "no"), attr("comment", b.comment)]);
          else await c.command(["/ip/hotspot/ip-binding/add", attr("mac-address", b.macAddress), attr("type", "bypassed"), attr("comment", b.comment)]);
        } else {
          for (const row of rows) await c.command(["/ip/hotspot/ip-binding/remove", attr(".id", row[".id"]!)]);
        }
        const check = await c.command(["/ip/hotspot/ip-binding/print", query("mac-address", b.macAddress)]);
        const verified = b.enabled ? check.length === 1 && check[0]!.type === "bypassed" && !yes(check[0]!.disabled) : check.length === 0;
        return { status: "SUCCEEDED" as const, verified, detail: `Device ${b.macAddress} ${b.enabled ? "let through without a login" : "removed from the bypass list"}` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async health(r: RouterTarget, opts: { uplinkInterface?: string | null } = {}): Promise<RouterHealth> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const [res] = await c.command(["/system/resource/print"]);
        const [id] = await c.command(["/system/identity/print"]);
        const metrics: RouterMetrics = {
          cpuLoad: intOf(res?.["cpu-load"]),
          memoryUsedPct: usedPct(res?.["free-memory"], res?.["total-memory"]),
          diskUsedPct: usedPct(res?.["free-hdd-space"], res?.["total-hdd-space"]),
          uptimeSeconds: parseUptime(res?.uptime),
        };
        // Optional readings: boards without sensors or the interface simply leave them out.
        const health = await c.command(["/system/health/print"]).catch(() => [] as Array<Record<string, string>>);
        const temp = health.find((row) => row.name === "temperature" || row.name === "cpu-temperature")?.value ?? health[0]?.temperature;
        if (temp !== undefined && Number.isFinite(Number(temp))) metrics.temperatureC = Number(temp);
        const iface = opts.uplinkInterface || (await c.command(["/interface/print", query("type", "ether"), query("running", "true")]).catch(() => []))[0]?.name;
        if (iface) {
          const [traffic] = await c.command(["/interface/monitor-traffic", attr("interface", iface), attr("once", "")]).catch(() => [] as Array<Record<string, string>>);
          metrics.rxBps = counter(traffic?.["rx-bits-per-second"]);
          metrics.txBps = counter(traffic?.["tx-bits-per-second"]);
          metrics.interfaceName = iface;
        }
        return { online: true, identity: id?.name, version: res?.version, board: res?.["board-name"], metrics, detail: `Uptime ${res?.uptime ?? "unknown"}, CPU ${res?.["cpu-load"] ?? "?"}%` };
      });
    } catch (err) {
      if (err instanceof RouterOsTrapError && err.category === "auth") return { online: false, detail: "Login rejected. Check the API user and password." };
      if (err instanceof RouterOsConnectionError) return { online: false, detail: err.message };
      return { online: false, detail: "Health check failed" };
    }
  }

  async reboot(r: RouterTarget): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        try {
          await c.command(["/system/reboot"]);
        } catch (err) {
          // The router drops the connection as it goes down: that is the expected answer to a reboot.
          if (!(err instanceof RouterOsConnectionError)) throw err;
        }
        return { status: "SUCCEEDED" as const, verified: null, detail: "Reboot command sent; the router restarts and is back in a minute or two" };
      });
    } catch (err) {
      classify(err);
    }
  }

  async setIdentity(r: RouterTarget, name: string): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        await c.command(["/system/identity/set", attr("name", name)]);
        const [check] = await c.command(["/system/identity/print"]);
        return { status: "SUCCEEDED" as const, verified: check?.name === name, detail: `Router identity set to ${name}` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async syncClock(r: RouterTarget, timezone: string): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        await c.command(["/system/clock/set", attr("time-zone-autodetect", "no"), attr("time-zone-name", timezone)]).catch(async (err) => {
          if (!(err instanceof RouterOsTrapError)) throw err;
          await c.command(["/system/clock/set", attr("time-zone-name", timezone)]); // RouterOS 6 has no autodetect switch
        });
        // RouterOS 7 takes server names; RouterOS 6 calls the field server-dns-names.
        const ntp = await c
          .command(["/system/ntp/client/set", attr("enabled", "yes"), attr("servers", "pool.ntp.org")])
          .then(() => "enabled")
          .catch(() =>
            c
              .command(["/system/ntp/client/set", attr("enabled", "yes"), attr("server-dns-names", "pool.ntp.org")])
              .then(() => "enabled")
              .catch(() => "not available"),
          );
        const [clock] = await c.command(["/system/clock/print"]);
        return { status: "SUCCEEDED" as const, verified: clock?.["time-zone-name"] === timezone, detail: `Time zone ${timezone}; NTP client ${ntp}` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async syncWalledGarden(r: RouterTarget, host: string): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        for (const path of ["/ip/hotspot/walled-garden", "/ip/hotspot/walled-garden/ip"]) {
          for (const row of await c.command([`${path}/print`, query("comment", "cloudlink")])) await c.command([`${path}/remove`, attr(".id", row[".id"]!)]);
        }
        await c.command(["/ip/hotspot/walled-garden/add", attr("dst-host", host), attr("comment", "cloudlink")]);
        await c.command(["/ip/hotspot/walled-garden/ip/add", attr("dst-host", host), attr("action", "accept"), attr("comment", "cloudlink")]);
        const http = await c.command(["/ip/hotspot/walled-garden/print", query("comment", "cloudlink")]);
        const ip = await c.command(["/ip/hotspot/walled-garden/ip/print", query("comment", "cloudlink")]);
        return { status: "SUCCEEDED" as const, verified: http.length === 1 && ip.length === 1, detail: `${host} allowed before login (HTTP and HTTPS)` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async installLoginPage(r: RouterTarget, url: string): Promise<OpResult> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const profiles = await c.command(["/ip/hotspot/profile/print"]);
        if (!profiles.length) throw new PermanentError("The router has no hotspot profile. Set up the hotspot first.", "NO_HOTSPOT_PROFILE");
        const files: string[] = [];
        for (const p of profiles) {
          const dir = p["html-directory"] || "hotspot";
          await c.command(["/tool/fetch", attr("url", url), attr("dst-path", `${dir}/login.html`)]);
          await c.command(["/ip/hotspot/profile/set", attr(".id", p[".id"]!), attr("login-by", "cookie,http-chap,http-pap")]);
          files.push(`${dir}/login.html`);
        }
        let present = 0;
        for (const f of files) present += (await c.command(["/file/print", query("name", f)])).length ? 1 : 0;
        return { status: "SUCCEEDED" as const, verified: present === files.length, detail: `Login page installed in ${files.join(", ")}; plain-password login allowed` };
      });
    } catch (err) {
      classify(err);
    }
  }

  async diagnose(r: RouterTarget, ctx: DiagnosisContext): Promise<DiagnosisCheck[]> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const checks: DiagnosisCheck[] = [];
        const read = (words: string[]) => c.command(words).catch((err) => (err instanceof RouterOsTrapError ? null : Promise.reject(err)));
        const [res] = await c.command(["/system/resource/print"]);
        const major = Number((res?.version ?? "").split(".")[0]);
        checks.push({ id: "api", label: "API login", status: "ok", detail: `Logged in. RouterOS ${res?.version ?? "unknown"} on ${res?.["board-name"] ?? "unknown board"}.` });
        checks.push({ id: "version", label: "RouterOS version", status: major >= 7 ? "ok" : "warning", detail: major >= 7 ? "RouterOS 7." : "RouterOS 6: supported, but version 7 is recommended." });
        const mem = usedPct(res?.["free-memory"], res?.["total-memory"]);
        const disk = usedPct(res?.["free-hdd-space"], res?.["total-hdd-space"]);
        const cpu = intOf(res?.["cpu-load"]);
        const busy = [cpu !== undefined && cpu > 85 ? `CPU ${cpu}%` : null, mem !== undefined && mem > 90 ? `memory ${mem}% used` : null, disk !== undefined && disk > 90 ? `storage ${disk}% used` : null].filter(Boolean);
        checks.push({ id: "resources", label: "Resources", status: busy.length ? "warning" : "ok", detail: busy.length ? `High: ${busy.join(", ")}.` : `CPU ${cpu ?? "?"}%, memory ${mem ?? "?"}% used, storage ${disk ?? "?"}% used.` });

        const [clock] = (await read(["/system/clock/print"])) ?? [];
        const tz = clock?.["time-zone-name"];
        checks.push({ id: "clock", label: "Clock and time zone", status: tz === ctx.timezone ? "ok" : "warning", detail: tz === ctx.timezone ? `${tz}.` : `Time zone is ${tz ?? "unknown"}; expected ${ctx.timezone}. Use “Sync router time”.` });
        const [ntp] = (await read(["/system/ntp/client/print"])) ?? [];
        checks.push({ id: "ntp", label: "NTP client", status: yes(ntp?.enabled) ? "ok" : "warning", detail: yes(ntp?.enabled) ? "Enabled." : "Not enabled: the clock may drift. Use “Sync router time”." });

        if (ctx.pppoe) {
          const servers = (await read(["/interface/pppoe-server/server/print"])) ?? [];
          const on = servers.filter((s) => !yes(s.disabled));
          checks.push({ id: "pppoe", label: "PPPoE server", status: on.length ? "ok" : "problem", detail: on.length ? `${on.length} PPPoE server(s) on ${on.map((s) => s.interface).join(", ")}.` : "No enabled PPPoE server: customers cannot dial in." });
        } else checks.push({ id: "pppoe", label: "PPPoE server", status: "skipped", detail: "PPPoE is not used on this router." });

        if (ctx.hotspot) {
          const servers = (await read(["/ip/hotspot/print"])) ?? [];
          const on = servers.filter((s) => !yes(s.disabled));
          checks.push({ id: "hotspot", label: "Hotspot server", status: on.length ? "ok" : "problem", detail: on.length ? `${on.length} hotspot server(s) on ${on.map((s) => s.interface).join(", ")}.` : "No enabled hotspot server: the captive portal cannot appear." });
          const profiles = (await read(["/ip/hotspot/profile/print"])) ?? [];
          const pap = profiles.length > 0 && profiles.every((p) => (p["login-by"] ?? "").includes("http-pap"));
          checks.push({ id: "login", label: "Portal login method", status: pap ? "ok" : "warning", detail: pap ? "Plain-password login allowed." : "HTTP PAP login is off, so the portal cannot sign devices in. Use “Reinstall hotspot login page”." });
          if (ctx.walledGardenHost) {
            const http = (await read(["/ip/hotspot/walled-garden/print"])) ?? [];
            const ip = (await read(["/ip/hotspot/walled-garden/ip/print"])) ?? [];
            const ok = http.some((w) => w["dst-host"] === ctx.walledGardenHost) && ip.some((w) => w["dst-host"] === ctx.walledGardenHost);
            checks.push({ id: "walled-garden", label: "Walled garden", status: ok ? "ok" : "warning", detail: ok ? `${ctx.walledGardenHost} reachable before login.` : `${ctx.walledGardenHost} is not fully in the walled garden. Use “Resync walled garden”.` });
          }
        } else checks.push({ id: "hotspot", label: "Hotspot server", status: "skipped", detail: "The hotspot is not used on this router." });

        if (ctx.radiusAddress) {
          const radius = (await read(["/radius/print"])) ?? [];
          const ok = radius.some((x) => x.address === ctx.radiusAddress && (x.service ?? "").includes("ppp"));
          checks.push({ id: "radius", label: "RADIUS", status: ok ? "ok" : "problem", detail: ok ? `PPP authenticates against ${ctx.radiusAddress}.` : `No RADIUS entry for ${ctx.radiusAddress} with service ppp.` });
        }

        const services = (await read(["/ip/service/print"])) ?? [];
        const open = services.filter((s) => (s.name === "api" || s.name === "api-ssl") && !yes(s.disabled) && !s.address);
        checks.push({ id: "api-access", label: "API access restricted", status: open.length ? "warning" : "ok", detail: open.length ? `${open.map((s) => s.name).join(", ")} accepts connections from any address. Run the setup command to restrict it.` : "API limited to management addresses." });

        if (ctx.profiles.length) {
          const ppp = new Set(((await read(["/ppp/profile/print"])) ?? []).map((p) => p.name));
          const hs = new Set(((await read(["/ip/hotspot/user/profile/print"])) ?? []).map((p) => p.name));
          const missing = ctx.profiles.filter((p) => !(p.kind === "PPPOE" ? ppp : hs).has(p.name)).map((p) => p.name);
          checks.push({ id: "profiles", label: "Plan profiles", status: missing.length ? "warning" : "ok", detail: missing.length ? `Missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}. Use “Push plans”.` : `All ${ctx.profiles.length} plan profile(s) present.` });
        }
        return checks;
      });
    } catch (err) {
      classify(err);
    }
  }

  async readLogs(r: RouterTarget, limit: number): Promise<LogLine[]> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const rows = await c.command(["/log/print"]);
        return rows.slice(-limit).reverse().map((l) => ({ time: l.time ?? "", topics: l.topics ?? "", message: (l.message ?? "").slice(0, 500) }));
      });
    } catch (err) {
      classify(err);
    }
  }

  async listSessions(r: RouterTarget): Promise<ActiveSession[]> {
    try {
      return await withRouter(rosOpts(r), async (c) => {
        const ppp = await c.command(["/ppp/active/print"]);
        // Routers without the hotspot package answer with !trap; treat that as "no hotspot sessions".
        const hs = await c.command(["/ip/hotspot/active/print"]).catch((err) => {
          if (err instanceof RouterOsTrapError) return [] as Array<Record<string, string>>;
          throw err;
        });
        // Devices let through by MAC (TV / streaming plans) are hosts marked bypassed; they never log in.
        const hosts = await c.command(["/ip/hotspot/host/print", query("bypassed", "true")]).catch((err) => {
          if (err instanceof RouterOsTrapError) return [] as Array<Record<string, string>>;
          throw err;
        });
        return [
          ...hosts.map((h) => ({ kind: "BINDING" as const, externalId: h[".id"]!, username: h["mac-address"] ?? "", address: h.address, macAddress: h["mac-address"], uptimeSeconds: parseUptime(h.uptime), bytesIn: counter(h["bytes-in"]), bytesOut: counter(h["bytes-out"]) })),
          ...ppp.map((a) => ({ kind: "PPPOE" as const, externalId: a[".id"]!, username: a.name ?? "", address: a.address, macAddress: a["caller-id"], uptimeSeconds: parseUptime(a.uptime) })),
          // Hotspot counters are from the client's side: bytes-in = uploaded by the client, bytes-out = downloaded.
          ...hs.map((a) => ({ kind: "HOTSPOT" as const, externalId: a[".id"]!, username: a.user ?? "", address: a.address, macAddress: a["mac-address"], uptimeSeconds: parseUptime(a.uptime), bytesIn: counter(a["bytes-in"]), bytesOut: counter(a["bytes-out"]) })),
        ];
      });
    } catch (err) {
      classify(err);
    }
  }
}

class DisabledNetworkAdapter implements NetworkAdapter {
  name = "disabled" as const;
  private fail(): never {
    throw new PermanentError("Network automation is disabled for this deployment (NETWORK_ADAPTER=disabled).", "NETWORK_DISABLED");
  }
  async upsertPppoeSecret(): Promise<OpResult> {
    this.fail();
  }
  async removePppoeSecret(): Promise<OpResult> {
    this.fail();
  }
  async upsertHotspotUser(): Promise<OpResult> {
    this.fail();
  }
  async disconnectSession(): Promise<OpResult> {
    this.fail();
  }
  async upsertProfile(): Promise<OpResult> {
    this.fail();
  }
  async setHotspotAccess(): Promise<OpResult> {
    this.fail();
  }
  async setDeviceBinding(): Promise<OpResult> {
    this.fail();
  }
  async health(): Promise<RouterHealth> {
    return { online: false, detail: "Network automation is disabled" };
  }
  async listSessions(): Promise<ActiveSession[]> {
    return [];
  }
  async reboot(): Promise<OpResult> {
    this.fail();
  }
  async setIdentity(): Promise<OpResult> {
    this.fail();
  }
  async syncClock(): Promise<OpResult> {
    this.fail();
  }
  async syncWalledGarden(): Promise<OpResult> {
    this.fail();
  }
  async installLoginPage(): Promise<OpResult> {
    this.fail();
  }
  async diagnose(): Promise<DiagnosisCheck[]> {
    this.fail();
  }
  async readLogs(): Promise<LogLine[]> {
    this.fail();
  }
}

export function networkAdapterName(): "mock" | "routeros" | "disabled" {
  const mode = process.env.NETWORK_ADAPTER || "mock";
  return mode === "mock" || mode === "routeros" ? mode : "disabled";
}

export function networkAdapter(): NetworkAdapter {
  const mode = networkAdapterName();
  if (mode === "mock") return new MockNetworkAdapter();
  if (mode === "routeros") return new RouterOsAdapter();
  return new DisabledNetworkAdapter();
}

/** RouterOS rate string for a kbps value (decimal units, as RouterOS uses): 10000 → "10M", 512 → "512k". */
export function kbpsToRate(kbps: number | null | undefined): string | null {
  if (!kbps) return null;
  return formatRate(kbps);
}
