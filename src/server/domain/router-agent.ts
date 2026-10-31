import { z } from "zod";
import { rosString } from "@/server/domain/routeros-setup";

/**
 * Cloudlink router agent (RouterOS scripting). Original Cloudlink content.
 *
 * The setup script installs a small script plus a scheduler on the router. Every minute the router:
 *  1. collects a short report (identity, RouterOS version, board, ports, addresses, bridge ports, DHCP clients);
 *  2. POSTs it to Cloudlink over HTTPS (`/api/v1/routers/agent/<key>`), which records the check-in;
 *  3. imports Cloudlink's answer: a comment when nothing changed, or a change made in Cloudlink (for example the
 *     services chosen in the link wizard), which ends by confirming itself to Cloudlink.
 * The router always connects out; Cloudlink never needs an open port on it. The key identifies one router only and is
 * rotated whenever the setup command runs again.
 */
export const AGENT_NAME = "cloudlink-agent";
export const AGENT_FILE = "cloudlink-agent.rsc";
/** A router counts as online while its last check-in is younger than this (it checks in every minute). */
export const AGENT_STALE_MS = 3 * 60_000;
/** A delivered change that is not confirmed within this time is sent again (at most MAX_DELIVERIES times). */
export const REDELIVER_AFTER_MS = 2 * 60_000;
export const MAX_DELIVERIES = 3;
const AGENT_POLICY = "ftp,read,write,policy,test,sensitive";
export const HOTSPOT_BRIDGE = "cloudlink-hotspot";
export const PPPOE_BRIDGE = "cloudlink-pppoe";

export interface AgentEndpoints {
  /** https://<cloudlink>/api/v1/routers/agent/<key> */
  checkInUrl: string;
  /** Ask RouterOS to verify Cloudlink's TLS certificate (needs the issuing CA trusted on the router). */
  verifyTls: boolean;
}

function tlsOption(url: string, verifyTls: boolean): string {
  return url.startsWith("https://") && verifyTls ? " check-certificate=yes-without-crl" : "";
}

/** The agent's RouterOS source, on one line. */
export function agentSource(e: AgentEndpoints): string {
  const tls = tlsOption(e.checkInUrl, e.verifyTls);
  return [
    `:local u ${rosString(e.checkInUrl)}`,
    `:local d ("v=1\\nidentity=" . [/system identity get name] . "\\nversion=" . [/system resource get version] . "\\nboard=" . [/system resource get board-name] . "\\nuptime=" . [/system resource get uptime])`,
    `:foreach i in=[/interface find dynamic=no] do={ :set d ($d . "\\nif=" . [/interface get $i name] . "|" . [/interface get $i type] . "|" . [/interface get $i running]) }`,
    `:foreach a in=[/ip address find dynamic=no] do={ :set d ($d . "\\naddr=" . [/ip address get $a address] . "|" . [/ip address get $a interface]) }`,
    `:foreach p in=[/interface bridge port find] do={ :set d ($d . "\\nport=" . [/interface bridge port get $p interface] . "|" . [/interface bridge port get $p bridge]) }`,
    `:foreach c in=[/ip dhcp-client find] do={ :set d ($d . "\\ndhcp=" . [/ip dhcp-client get $c interface] . "|" . [/ip dhcp-client get $c address]) }`,
    `:local ok false`,
    `:do { /tool fetch url=$u http-method=post http-header-field="content-type: text/plain" http-data=$d dst-path="${AGENT_FILE}"${tls}; :set ok true } on-error={ :log warning "Cloudlink: check-in failed" }`,
    `:if ($ok) do={ :delay 1s; :do { /import file-name="${AGENT_FILE}" } on-error={ :log error "Cloudlink: a change from Cloudlink failed"; :do { /tool fetch url=($u . "/result") http-method=post http-header-field="content-type: text/plain" http-data="status=failed" output=none${tls} } on-error={} } }`,
    `:do { /file remove [find name="${AGENT_FILE}"] } on-error={}`,
  ].join("; ");
}

/** Setup-script lines: name the router and install the agent (script + one-minute scheduler), then check in once. */
export function agentInstallLines(routerName: string, endpoints: AgentEndpoints): string[] {
  return [
    `/system identity set name=${rosString(routerName)}`,
    `/system scheduler remove [find name="${AGENT_NAME}"]`,
    `/system script remove [find name="${AGENT_NAME}"]`,
    `/system script add name="${AGENT_NAME}" policy=${AGENT_POLICY} source=${rosString(agentSource(endpoints))}`,
    `/system scheduler add name="${AGENT_NAME}" interval=1m start-time=startup policy=${AGENT_POLICY} on-event="/system script run ${AGENT_NAME}" comment="Cloudlink agent"`,
    `:do { /system script run ${AGENT_NAME} } on-error={ :log warning "Cloudlink setup: first check-in failed; the agent retries every minute" }`,
  ];
}

export function idleScript(now: Date): string {
  return `# Cloudlink ${now.toISOString()}: nothing to change\n`;
}

/** Sent to a router whose record was archived in Cloudlink: removes the agent so it stops checking in. */
export function unlinkScript(): string {
  return [
    "# This router was removed from Cloudlink. Removing the Cloudlink agent.",
    `/system scheduler remove [find name="${AGENT_NAME}"]`,
    `/system script remove [find name="${AGENT_NAME}"]`,
    `:log warning "Cloudlink: this router was removed from Cloudlink; the agent was uninstalled"`,
    "",
  ].join("\n");
}

// ───────── Check-in report ─────────

const IFACE = /^[A-Za-z0-9 ._()<>/@+:-]{1,64}$/;
export const interfaceName = z.string().trim().regex(IFACE, "Enter an interface name such as ether2");

export interface AgentReport {
  identity: string | null;
  version: string | null;
  board: string | null;
  uptime: string | null;
  interfaces: { name: string; type: string; running: boolean }[];
  addresses: { address: string; interface: string }[];
  bridgePorts: { interface: string; bridge: string }[];
  dhcpClients: { interface: string; address: string | null }[];
  /** Set only by the test-mode simulation; never by a real router. */
  simulated?: boolean;
}

const MAX_ITEMS = 256;
const clean = (v: string | undefined, max = 80) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null;

function isCidr(v: string): boolean {
  const [ip, prefix] = v.split("/");
  if (!ip || prefix === undefined || !/^\d{1,3}$/.test(prefix)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split(".").every((o) => Number(o) <= 255) && Number(prefix) <= 32;
  return /^[0-9a-fA-F:]{2,39}$/.test(ip) && Number(prefix) <= 128;
}

/** Parse the router's report (line-based `key=value|value`). Unknown or malformed lines are ignored. */
export function parseAgentReport(text: string): AgentReport {
  const r: AgentReport = { identity: null, version: null, board: null, uptime: null, interfaces: [], addresses: [], bridgePorts: [], dhcpClients: [] };
  for (const line of text.slice(0, 65_536).split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    const parts = value.split("|").map((p) => p.trim());
    switch (key) {
      case "identity":
        r.identity = clean(value, 64);
        break;
      case "version":
        r.version = clean(value, 40);
        break;
      case "board":
        r.board = clean(value, 64);
        break;
      case "uptime":
        r.uptime = clean(value, 40);
        break;
      case "if":
        if (r.interfaces.length < MAX_ITEMS && IFACE.test(parts[0] ?? "") && !r.interfaces.some((i) => i.name === parts[0])) {
          r.interfaces.push({ name: parts[0]!, type: clean(parts[1], 32) ?? "unknown", running: parts[2] === "true" });
        }
        break;
      case "addr":
        if (r.addresses.length < MAX_ITEMS && isCidr(parts[0] ?? "") && IFACE.test(parts[1] ?? "")) r.addresses.push({ address: parts[0]!, interface: parts[1]! });
        break;
      case "port":
        if (r.bridgePorts.length < MAX_ITEMS && IFACE.test(parts[0] ?? "") && IFACE.test(parts[1] ?? "")) r.bridgePorts.push({ interface: parts[0]!, bridge: parts[1]! });
        break;
      case "dhcp":
        if (r.dhcpClients.length < 16 && IFACE.test(parts[0] ?? "")) r.dhcpClients.push({ interface: parts[0]!, address: isCidr(parts[1] ?? "") ? parts[1]! : null });
        break;
    }
  }
  return r;
}

const PORT_TYPES = new Set(["ether", "wlan", "wifi", "wifiwave2", "vlan"]);
const OWN_BRIDGES = new Set([HOTSPOT_BRIDGE, PPPOE_BRIDGE]);

export interface RouterPort {
  name: string;
  type: string;
  running: boolean;
  /** Bridge the port is in now (other than Cloudlink's own bridges). */
  bridge: string | null;
  /** Addresses set directly on the port. */
  addresses: string[];
}

/** Ports that can serve customers (Ethernet, wireless, VLAN). */
export function servicePorts(report: AgentReport): RouterPort[] {
  return report.interfaces
    .filter((i) => PORT_TYPES.has(i.type) && !OWN_BRIDGES.has(i.name))
    .map((i) => {
      const bridge = report.bridgePorts.find((p) => p.interface === i.name)?.bridge ?? null;
      return { name: i.name, type: i.type, running: i.running, bridge: bridge && !OWN_BRIDGES.has(bridge) ? bridge : null, addresses: report.addresses.filter((a) => a.interface === i.name).map((a) => a.address) };
    });
}

/** Interfaces that can carry the internet uplink (anything but Cloudlink's bridges). */
export function wanChoices(report: AgentReport): string[] {
  return report.interfaces.filter((i) => !OWN_BRIDGES.has(i.name) && !report.bridgePorts.some((p) => p.interface === i.name)).map((i) => i.name);
}

/** Best guess for the internet port: the interface with a DHCP client, else ether1. */
export function guessWan(report: AgentReport): string | null {
  const choices = wanChoices(report);
  const dhcp = report.dhcpClients.find((c) => choices.includes(c.interface));
  if (dhcp) return dhcp.interface;
  return choices.includes("ether1") ? "ether1" : (choices[0] ?? null);
}

// ───────── Services chosen in the link wizard ─────────

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

interface Ipv4Net {
  base: number;
  prefix: number;
}
const PRIVATE_V4: Ipv4Net[] = [
  { base: 0x0a000000, prefix: 8 },
  { base: 0xac100000, prefix: 12 },
  { base: 0xc0a80000, prefix: 16 },
  { base: 0x64400000, prefix: 10 },
];
const mask = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const ipToInt = (ip: string) => ip.split(".").reduce((n, o) => ((n << 8) >>> 0) + Number(o), 0) >>> 0;
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** Parse an IPv4 network such as 10.5.50.0/24. Returns an error message when it is not usable. */
export function parseIpv4Network(value: string, minPrefix: number, maxPrefix: number): Ipv4Net | string {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if (!m || m[1]!.split(".").some((o) => Number(o) > 255)) return "Enter a network such as 10.5.50.0/24";
  const prefix = Number(m[2]);
  if (prefix < minPrefix || prefix > maxPrefix) return `Use a prefix between /${minPrefix} and /${maxPrefix}`;
  const base = ipToInt(m[1]!);
  if ((base & mask(prefix)) >>> 0 !== base) return `Use the network address (${intToIp((base & mask(prefix)) >>> 0)}/${prefix})`;
  if (!PRIVATE_V4.some((p) => p.prefix <= prefix && ((base & mask(p.prefix)) >>> 0) === p.base)) return "Use a private network (10.x, 172.16–31.x, 192.168.x or 100.64.x)";
  return { base, prefix };
}

function overlaps(a: Ipv4Net, b: Ipv4Net): boolean {
  const m = mask(Math.min(a.prefix, b.prefix));
  return ((a.base & m) >>> 0) === ((b.base & m) >>> 0);
}

export const servicesInput = z
  .object({
    hotspot: z.boolean(),
    pppoe: z.boolean(),
    /** The port that connects the router to the internet. */
    wanInterface: interfaceName,
    ports: z.array(z.object({ name: interfaceName, use: z.enum(["hotspot", "pppoe", "both"]) })).max(48),
    hotspotNetwork: z.string().trim().default("10.5.50.0/24"),
    hotspotDnsName: z.string().trim().toLowerCase().max(253).regex(HOSTNAME, "Enter a host name such as wifi.login").default("wifi.login"),
    /** Default devices per hotspot login; plans with their own device limit override it. */
    devicesPerLogin: z.coerce.number().int().min(1).max(10).default(1),
    /** Stop customers re-sharing the hotspot (phone tethering, a second router): packets to clients leave with TTL 1. */
    blockSharing: z.boolean().default(true),
    pppoeNetwork: z.string().trim().default("10.10.0.0/16"),
  })
  .superRefine((v, ctx) => {
    if (!v.hotspot && !v.pppoe) ctx.addIssue({ code: "custom", path: ["hotspot"], message: "Choose at least one service" });
    const seen = new Set<string>();
    v.ports.forEach((p, i) => {
      if (seen.has(p.name)) ctx.addIssue({ code: "custom", path: ["ports", i, "name"], message: `${p.name} is listed twice` });
      seen.add(p.name);
      if (p.name === v.wanInterface) ctx.addIssue({ code: "custom", path: ["ports", i, "name"], message: "The internet port cannot also serve customers" });
      if ((p.use === "hotspot" || p.use === "both") && !v.hotspot) ctx.addIssue({ code: "custom", path: ["ports", i, "use"], message: "Hotspot is not selected" });
      if ((p.use === "pppoe" || p.use === "both") && !v.pppoe) ctx.addIssue({ code: "custom", path: ["ports", i, "use"], message: "PPPoE is not selected" });
    });
    if (v.hotspot && !v.ports.some((p) => p.use !== "pppoe")) ctx.addIssue({ code: "custom", path: ["ports"], message: "Choose at least one port for the hotspot" });
    if (v.pppoe && !v.ports.some((p) => p.use !== "hotspot")) ctx.addIssue({ code: "custom", path: ["ports"], message: "Choose at least one port for PPPoE" });
    const hs = v.hotspot ? parseIpv4Network(v.hotspotNetwork, 16, 29) : null;
    const pp = v.pppoe ? parseIpv4Network(v.pppoeNetwork, 16, 28) : null;
    if (typeof hs === "string") ctx.addIssue({ code: "custom", path: ["hotspotNetwork"], message: hs });
    if (typeof pp === "string") ctx.addIssue({ code: "custom", path: ["pppoeNetwork"], message: pp });
    if (hs && pp && typeof hs !== "string" && typeof pp !== "string" && overlaps(hs, pp)) ctx.addIssue({ code: "custom", path: ["pppoeNetwork"], message: "Overlaps the hotspot network" });
  });
export type ServicesConfig = z.infer<typeof servicesInput>;

export interface ServicesPlan {
  hotspotPorts: string[];
  /** Ports that serve PPPoE only (own bridge). Ports marked "both" sit in the hotspot bridge, which then also runs PPPoE. */
  pppoePorts: string[];
  pppoeServers: string[];
  hotspot: { network: string; prefix: number; gateway: string; poolRange: string } | null;
  pppoe: { network: string; prefix: number; localAddress: string; poolRange: string } | null;
}

/** Addressing derived from a validated configuration. */
export function planServices(cfg: ServicesConfig): ServicesPlan {
  const hotspotPorts = cfg.hotspot ? cfg.ports.filter((p) => p.use !== "pppoe").map((p) => p.name) : [];
  const pppoePorts = cfg.pppoe ? cfg.ports.filter((p) => p.use === "pppoe").map((p) => p.name) : [];
  const pppoeServers = cfg.pppoe ? [...(pppoePorts.length ? [PPPOE_BRIDGE] : []), ...(cfg.ports.some((p) => p.use === "both") ? [HOTSPOT_BRIDGE] : [])] : [];
  let hotspot: ServicesPlan["hotspot"] = null;
  if (cfg.hotspot) {
    const n = parseIpv4Network(cfg.hotspotNetwork, 16, 29) as Ipv4Net;
    const size = 2 ** (32 - n.prefix);
    hotspot = { network: `${intToIp(n.base)}/${n.prefix}`, prefix: n.prefix, gateway: intToIp(n.base + 1), poolRange: `${intToIp(n.base + (size >= 64 ? 10 : 2))}-${intToIp(n.base + size - 2)}` };
  }
  let pppoe: ServicesPlan["pppoe"] = null;
  if (cfg.pppoe) {
    const n = parseIpv4Network(cfg.pppoeNetwork, 16, 28) as Ipv4Net;
    const size = 2 ** (32 - n.prefix);
    pppoe = { network: `${intToIp(n.base)}/${n.prefix}`, prefix: n.prefix, localAddress: intToIp(n.base + 1), poolRange: `${intToIp(n.base + 2)}-${intToIp(n.base + size - 2)}` };
  }
  return { hotspotPorts, pppoePorts, pppoeServers, hotspot, pppoe };
}

/** Problems with a configuration given what the router reported (unknown ports, networks already in use). */
export function checkAgainstReport(cfg: ServicesConfig, report: AgentReport): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const ports = new Set(servicePorts(report).map((p) => p.name));
  cfg.ports.forEach((p, i) => {
    if (!ports.has(p.name)) problems.push({ path: `ports.${i}.name`, message: `The router did not report a port called ${p.name}` });
  });
  if (!report.interfaces.some((i) => i.name === cfg.wanInterface)) problems.push({ path: "wanInterface", message: `The router did not report ${cfg.wanInterface}` });
  const nets: [string, string, boolean][] = [
    ["hotspotNetwork", cfg.hotspotNetwork, cfg.hotspot],
    ["pppoeNetwork", cfg.pppoeNetwork, cfg.pppoe],
  ];
  for (const [path, value, enabled] of nets) {
    if (!enabled) continue;
    const net = parseIpv4Network(value, 16, 29);
    if (typeof net === "string") continue;
    for (const a of report.addresses) {
      if (OWN_BRIDGES.has(a.interface) || !/^\d/.test(a.address)) continue;
      const [ip, prefix] = a.address.split("/");
      const existing = { base: (ipToInt(ip!) & mask(Number(prefix))) >>> 0, prefix: Number(prefix) };
      if (overlaps(net, existing)) {
        problems.push({ path, message: `Overlaps ${a.address} on ${a.interface}` });
        break;
      }
    }
  }
  return problems;
}

export interface ServicesScriptInput {
  routerName: string;
  changeId: string;
  config: ServicesConfig;
  /** https://<cloudlink>/api/v1/routers/agent/<key>/result */
  resultUrl: string;
  verifyTls: boolean;
  /** Cloudlink's host name for the hotspot walled garden. */
  portalHost: string | null;
  /** Cloudlink's login page for this router. */
  loginUrl: string | null;
  generatedAt: Date;
}

/**
 * The services change sent through the agent. Idempotent: it first removes only what Cloudlink created before
 * (matched by name or comment), then builds the chosen services. Every block is one line, as RouterOS imports
 * line by line; the last line confirms the change to Cloudlink, so a failed line means no confirmation.
 */
export function buildServicesScript(input: ServicesScriptInput): string {
  const q = rosString;
  const cfg = input.config;
  const plan = planServices(cfg);
  const tls = tlsOption(input.resultUrl, input.verifyTls);
  const name = input.routerName.replace(/[^A-Za-z0-9 ._()[\]-]/g, "").slice(0, 60);
  const H = HOTSPOT_BRIDGE;
  const P = PPPOE_BRIDGE;
  const wan = q(cfg.wanInterface);
  const ensure = (menu: string, find: string, set: string) => `:if ([:len [${menu} find ${find}]] = 0) do={ ${menu} add ${find} ${set} } else={ ${menu} set [find ${find}] ${set} }`;

  const lines: string[] = [
    `# Cloudlink services for ${name}`,
    `# Change ${input.changeId}, generated ${input.generatedAt.toISOString()}. Running it again gives the same result.`,
    `:log info "Cloudlink: applying services"`,
    "",
    "# 1. Remove what Cloudlink set up before (only items Cloudlink created)",
    `:do { /ip hotspot remove [find name="cloudlink"] } on-error={}`,
    `:do { /interface pppoe-server server remove [find service-name="cloudlink"] } on-error={}`,
    `/ip dhcp-server remove [find name="${H}"]`,
    `/ip dhcp-server network remove [find comment="${H}"]`,
    `/ip firewall nat remove [find comment="${H}"]`,
    `/ip firewall nat remove [find comment="${P}"]`,
    `/ip firewall mangle remove [find comment="cloudlink-no-sharing"]`,
    `/ip firewall filter remove [find comment="cloudlink-dns-guard"]`,
    `/ip address remove [find comment="${H}"]`,
    `/interface bridge port remove [find comment="cloudlink"]`,
    "",
    "# 2. Customer ports (each chosen port leaves any other bridge and joins Cloudlink's bridge)",
  ];
  for (const [bridge, ports] of [
    [H, plan.hotspotPorts],
    [P, plan.pppoePorts],
  ] as const) {
    if (ports.length) {
      lines.push(`:if ([:len [/interface bridge find name="${bridge}"]] = 0) do={ /interface bridge add name="${bridge}" comment="cloudlink" }`);
      for (const port of ports) lines.push(`/interface bridge port remove [find interface=${q(port)}]`, `/interface bridge port add bridge="${bridge}" interface=${q(port)} comment="cloudlink"`);
    } else {
      lines.push(`:do { /interface bridge remove [find name="${bridge}"] } on-error={}`);
    }
  }
  lines.push(
    "",
    "# 3. The router answers customers' DNS queries; queries from the internet port are dropped",
    `/ip dns set allow-remote-requests=yes`,
    `/ip firewall filter add chain=input in-interface=${wan} protocol=udp dst-port=53 action=drop comment="cloudlink-dns-guard"`,
    `/ip firewall filter add chain=input in-interface=${wan} protocol=tcp dst-port=53 action=drop comment="cloudlink-dns-guard"`,
    `:do { /ip firewall filter move [find comment="cloudlink-dns-guard"] destination=0 } on-error={}`,
  );
  if (plan.hotspot) {
    const h = plan.hotspot;
    lines.push(
      "",
      `# 4. Hotspot on ${plan.hotspotPorts.join(", ")}: gateway ${h.gateway}, ${cfg.devicesPerLogin} device(s) per login`,
      `/ip address add address=${h.gateway}/${h.prefix} interface="${H}" comment="${H}"`,
      ensure("/ip pool", `name="${H}"`, `ranges=${h.poolRange}`),
      `/ip dhcp-server add name="${H}" interface="${H}" address-pool="${H}" lease-time=1h disabled=no`,
      `/ip dhcp-server network add address=${h.network} gateway=${h.gateway} dns-server=${h.gateway} comment="${H}"`,
      `:if ([:len [/ip hotspot profile find name="cloudlink"]] = 0) do={ /ip hotspot profile add name="cloudlink" }`,
      `/ip hotspot profile set [find name="cloudlink"] hotspot-address=${h.gateway} dns-name=${q(cfg.hotspotDnsName)} login-by=cookie,http-chap,http-pap`,
      `/ip hotspot add name="cloudlink" interface="${H}" address-pool="${H}" profile="cloudlink" disabled=no`,
      `/ip hotspot user profile set [find name="default"] shared-users=${cfg.devicesPerLogin}`,
      `/ip firewall nat add chain=srcnat src-address=${h.network} out-interface=${wan} action=masquerade comment="${H}"`,
    );
    if (input.portalHost) {
      lines.push(
        `:do { /ip hotspot walled-garden remove [find comment="cloudlink"]; /ip hotspot walled-garden add dst-host=${q(input.portalHost)} comment="cloudlink" } on-error={}`,
        `:do { /ip hotspot walled-garden ip remove [find comment="cloudlink"]; /ip hotspot walled-garden ip add dst-host=${q(input.portalHost)} action=accept comment="cloudlink" } on-error={}`,
      );
    }
    if (input.loginUrl) {
      lines.push(
        `:delay 2s`,
        `:do { :local dir [/ip hotspot profile get [find name="cloudlink"] html-directory]; :if ([:len $dir] = 0) do={ :set dir "hotspot" }; /tool fetch url=${q(input.loginUrl)} dst-path=($dir . "/login.html")${tlsOption(input.loginUrl, input.verifyTls)} } on-error={ :log warning "Cloudlink: could not download the hotspot login page" }`,
      );
    }
    if (cfg.blockSharing) {
      lines.push(
        "# Block connection sharing: packets to hotspot clients leave with TTL 1, so a phone or router re-sharing the connection cannot forward them",
        `/ip firewall mangle add chain=postrouting out-interface="${H}" action=change-ttl new-ttl=set:1 passthrough=no comment="cloudlink-no-sharing"`,
      );
    }
  }
  if (plan.pppoe) {
    const p = plan.pppoe;
    const profile = `local-address=${p.localAddress} remote-address="${P}" dns-server=${p.localAddress}`;
    lines.push(
      "",
      `# 5. PPPoE server: router ${p.localAddress}, customer addresses ${p.poolRange}`,
      ensure("/ip pool", `name="${P}"`, `ranges=${p.poolRange}`),
      `:if ([:len [/ppp profile find name="cloudlink"]] = 0) do={ /ppp profile add name="cloudlink" }`,
      `/ppp profile set [find name="cloudlink"] ${profile}`,
      `:foreach x in=[/ppp profile find comment~"^cloudlink plan"] do={ /ppp profile set $x ${profile} }`,
      ...plan.pppoeServers.map((iface) => `/interface pppoe-server server add service-name="cloudlink" interface="${iface}" default-profile="cloudlink" one-session-per-host=yes disabled=no`),
      `/ip firewall nat add chain=srcnat src-address=${p.network} out-interface=${wan} action=masquerade comment="${P}"`,
    );
  }
  lines.push(
    "",
    "# 6. Confirm to Cloudlink",
    `/tool fetch url=${q(input.resultUrl)} http-method=post http-header-field="content-type: text/plain" http-data=${q(`status=applied&change=${input.changeId}`)} output=none${tls}`,
    `:log info "Cloudlink: services applied"`,
    "",
  );
  return lines.join("\n");
}

/** Parse the router's confirmation (`status=applied&change=<id>` or `status=failed`). */
export function parseAgentResult(text: string): { status: "applied" | "failed" | null; changeId: string | null } {
  const fields = new Map(
    text
      .slice(0, 1024)
      .split(/[&\r\n]/)
      .map((kv) => kv.split("=") as [string, string | undefined])
      .filter(([k]) => k)
      .map(([k, v]) => [k.trim(), (v ?? "").trim()]),
  );
  const status = fields.get("status");
  const change = fields.get("change") ?? "";
  return {
    status: status === "applied" || status === "failed" ? status : null,
    changeId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(change) ? change.toLowerCase() : null,
  };
}

/** Test mode: a report like a MikroTik with its default configuration (ports 2–5 and Wi-Fi in "bridge"). */
export function simulatedReport(identity: string, services: ServicesConfig | null): AgentReport {
  const ports = ["ether2", "ether3", "ether4", "ether5", "wlan1"];
  const assigned = new Map((services?.ports ?? []).map((p) => [p.name, p.use === "pppoe" ? PPPOE_BRIDGE : HOTSPOT_BRIDGE]));
  const plan = services ? planServices(services) : null;
  return {
    identity,
    version: "7.16.2 (simulated)",
    board: "Simulated router",
    uptime: "1h",
    interfaces: [
      { name: "ether1", type: "ether", running: true },
      ...ports.map((name, i) => ({ name, type: name.startsWith("wlan") ? "wlan" : "ether", running: i % 2 === 0 })),
      { name: "bridge", type: "bridge", running: true },
      ...(plan?.hotspotPorts.length ? [{ name: HOTSPOT_BRIDGE, type: "bridge", running: true }] : []),
      ...(plan?.pppoePorts.length ? [{ name: PPPOE_BRIDGE, type: "bridge", running: true }] : []),
    ],
    addresses: [
      { address: "192.168.88.1/24", interface: "bridge" },
      { address: "192.0.2.10/24", interface: "ether1" },
      ...(plan?.hotspot ? [{ address: `${plan.hotspot.gateway}/${plan.hotspot.prefix}`, interface: HOTSPOT_BRIDGE }] : []),
    ],
    bridgePorts: ports.map((name) => ({ interface: name, bridge: assigned.get(name) ?? "bridge" })),
    dhcpClients: [{ interface: "ether1", address: "192.0.2.10/24" }],
    simulated: true,
  };
}
