import net from "node:net";

/**
 * Router management address policy.
 *
 * Cloudlink only talks to routers over private connectivity (LAN, VPN, WireGuard, CGNAT overlay):
 * 1. The host must be an IP literal. Hostnames are rejected so the target cannot be moved through DNS.
 * 2. The address must be private: RFC 1918, CGNAT 100.64.0.0/10 or IPv6 ULA fc00::/7.
 *    Loopback is accepted only outside production (local fake-router tests).
 * 3. If MIKROTIK_ALLOWED_NETWORKS is set (comma-separated CIDRs), the address must also be inside it.
 *    In production with the RouterOS adapter the allowlist is mandatory (enforced by env validation).
 */
type Family = "ipv4" | "ipv6";
export interface Cidr {
  address: string;
  prefix: number;
  family: Family;
}

const PRIVATE: Cidr[] = [
  { address: "10.0.0.0", prefix: 8, family: "ipv4" },
  { address: "172.16.0.0", prefix: 12, family: "ipv4" },
  { address: "192.168.0.0", prefix: 16, family: "ipv4" },
  { address: "100.64.0.0", prefix: 10, family: "ipv4" },
  { address: "fc00::", prefix: 7, family: "ipv6" },
];
const LOOPBACK: Cidr[] = [
  { address: "127.0.0.0", prefix: 8, family: "ipv4" },
  { address: "::1", prefix: 128, family: "ipv6" },
];

function familyOf(ip: string): Family | null {
  const v = net.isIP(ip);
  return v === 4 ? "ipv4" : v === 6 ? "ipv6" : null;
}

export function parseCidr(entry: string): Cidr {
  const [address, prefixText] = entry.trim().split("/");
  const family = address ? familyOf(address) : null;
  if (!address || !family) throw new Error(`"${entry}" is not an IP network`);
  const max = family === "ipv4" ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`"${entry}" has an invalid prefix length`);
  return { address, prefix, family };
}

export function parseCidrList(value: string): Cidr[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCidr);
}

function blockList(cidrs: Cidr[]): net.BlockList {
  const list = new net.BlockList();
  for (const c of cidrs) list.addSubnet(c.address, c.prefix, c.family);
  return list;
}

const privateList = blockList(PRIVATE);
const loopbackList = blockList(LOOPBACK);

/** True when every address of the network lies inside the private ranges (used to validate the allowlist itself). */
export function isPrivateNetwork(c: Cidr, allowLoopback = false): boolean {
  const lists = allowLoopback ? [privateList, loopbackList] : [privateList];
  const inside = (ip: string) => lists.some((l) => l.check(ip, c.family));
  if (!inside(c.address)) return false;
  // The first address is inside a private range; check the broadest private range covering it is at least as wide.
  const ranges = [...PRIVATE, ...(allowLoopback ? LOOPBACK : [])].filter((r) => r.family === c.family && blockList([r]).check(c.address, c.family));
  return ranges.some((r) => r.prefix <= c.prefix);
}

export type HostCheck = { ok: true } | { ok: false; reason: string };

export function checkRouterHost(host: string, opts: { allowedNetworks: string; allowLoopback: boolean }): HostCheck {
  const family = familyOf(host);
  if (!family) return { ok: false, reason: "Use the router's private or VPN IP address. Hostnames are not accepted." };
  const isLoopback = loopbackList.check(host, family);
  if (isLoopback && !opts.allowLoopback) return { ok: false, reason: "Loopback addresses are not allowed in this environment." };
  if (!isLoopback && !privateList.check(host, family)) {
    return { ok: false, reason: "Router management must use a private network or VPN address. Public addresses are refused." };
  }
  if (opts.allowedNetworks.trim()) {
    let allowed: Cidr[];
    try {
      allowed = parseCidrList(opts.allowedNetworks);
    } catch {
      return { ok: false, reason: "MIKROTIK_ALLOWED_NETWORKS is misconfigured." };
    }
    if (!blockList(allowed).check(host, family)) return { ok: false, reason: "This address is outside the allowed router networks (MIKROTIK_ALLOWED_NETWORKS)." };
  }
  return { ok: true };
}
