import { describe, expect, it } from "vitest";
import { attr, decodeLength, encodeLength, encodeSentence, parseAttributes, query, RouterOsInputError, SentenceReader } from "@/server/integrations/routeros/protocol";
import { checkRouterHost, isPrivateNetwork, parseCidr, parseCidrList } from "@/server/domain/network-address";
import { classify, kbpsToRate, parseUptime, rosDuration } from "@/server/integrations/network";
import { RouterOsConnectionError, RouterOsTrapError } from "@/server/integrations/routeros/client";
import { PermanentError, RetryableError } from "@/server/jobs/operations";
import { parseEnv } from "@/server/env";

describe("RouterOS wire protocol", () => {
  it("round-trips every length-prefix size at its boundaries", () => {
    for (const len of [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0xfffffff, 0x10000000, 0x7fffffff]) {
      const enc = encodeLength(len);
      const dec = decodeLength(enc, 0);
      expect(dec).toEqual({ length: len, bytes: enc.length });
    }
    expect(encodeLength(0x7f)).toHaveLength(1);
    expect(encodeLength(0x80)).toHaveLength(2);
    expect(encodeLength(0x4000)).toHaveLength(3);
    expect(encodeLength(0x200000)).toHaveLength(4);
    expect(encodeLength(0x10000000)).toHaveLength(5);
  });

  it("asks for more bytes when a prefix is incomplete", () => {
    const enc = encodeLength(0x4000);
    expect(decodeLength(enc.subarray(0, 1), 0)).toBeNull();
    expect(decodeLength(Buffer.alloc(0), 0)).toBeNull();
  });

  it("reassembles sentences split at every byte and batched together", () => {
    const a = encodeSentence(["/ppp/secret/add", "=name=jane", "=comment=" + "x".repeat(300)]);
    const b = encodeSentence(["!done", "=ret=*1"]);
    const all = Buffer.concat([a, b]);
    const reader = new SentenceReader();
    const out: string[][] = [];
    for (let i = 0; i < all.length; i++) out.push(...reader.push(all.subarray(i, i + 1)));
    expect(out).toEqual([
      ["/ppp/secret/add", "=name=jane", "=comment=" + "x".repeat(300)],
      ["!done", "=ret=*1"],
    ]);
    expect(new SentenceReader().push(all)).toHaveLength(2);
  });

  it("encodes UTF-8 by byte length", () => {
    const s = encodeSentence(["=comment=Wanjikũ"]);
    expect(new SentenceReader().push(s)).toEqual([["=comment=Wanjikũ"]]);
  });

  it("parses attributes whose values contain '='", () => {
    expect(parseAttributes(["=name=a", "=comment=x=y", "!re", "=.id=*1A"])).toEqual({ name: "a", comment: "x=y", ".id": "*1A" });
  });

  it("refuses values that could smuggle extra words, and invalid keys", () => {
    expect(() => attr("name", "a\nb")).toThrow(RouterOsInputError);
    expect(() => attr("name", "a\u0000")).toThrow(RouterOsInputError);
    expect(() => query("name", "x\r")).toThrow(RouterOsInputError);
    expect(() => attr("na me", "x")).toThrow(RouterOsInputError);
    expect(() => attr("name=x", "y")).toThrow(RouterOsInputError);
    expect(attr("limit-uptime", "1d")).toBe("=limit-uptime=1d");
    expect(query("name", "jane")).toBe("?name=jane");
  });
});

describe("router address policy", () => {
  const open = { allowedNetworks: "", allowLoopback: false };

  it("accepts private, CGNAT and ULA addresses; refuses public addresses and hostnames", () => {
    for (const ip of ["10.0.0.1", "172.16.5.1", "172.31.255.254", "192.168.88.1", "100.64.0.10", "fd00::1"]) expect(checkRouterHost(ip, open)).toEqual({ ok: true });
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860::1", "169.254.1.1"]) expect(checkRouterHost(ip, open).ok).toBe(false);
    expect(checkRouterHost("router.example.com", open)).toMatchObject({ ok: false, reason: expect.stringMatching(/Hostnames are not accepted/) });
  });

  it("allows loopback only when explicitly permitted (never in production)", () => {
    expect(checkRouterHost("127.0.0.1", open).ok).toBe(false);
    expect(checkRouterHost("127.0.0.1", { allowedNetworks: "", allowLoopback: true }).ok).toBe(true);
  });

  it("enforces MIKROTIK_ALLOWED_NETWORKS when configured", () => {
    const opts = { allowedNetworks: "10.20.0.0/16, 192.168.88.0/24", allowLoopback: false };
    expect(checkRouterHost("10.20.3.4", opts).ok).toBe(true);
    expect(checkRouterHost("192.168.88.1", opts).ok).toBe(true);
    expect(checkRouterHost("10.21.0.1", opts)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the allowed router networks/) });
  });

  it("parses CIDRs and decides whether a network lies inside private space", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ address: "10.0.0.0", prefix: 8, family: "ipv4" });
    expect(parseCidr("192.168.1.1")).toEqual({ address: "192.168.1.1", prefix: 32, family: "ipv4" });
    expect(() => parseCidr("10.0.0.0/33")).toThrow();
    expect(() => parseCidrList("10.0.0.0/8,nonsense")).toThrow();
    expect(isPrivateNetwork(parseCidr("10.0.0.0/8"))).toBe(true);
    expect(isPrivateNetwork(parseCidr("192.168.10.0/24"))).toBe(true);
    expect(isPrivateNetwork(parseCidr("10.0.0.0/7"))).toBe(false);
    expect(isPrivateNetwork(parseCidr("0.0.0.0/0"))).toBe(false);
    expect(isPrivateNetwork(parseCidr("127.0.0.0/8"))).toBe(false);
    expect(isPrivateNetwork(parseCidr("127.0.0.0/8"), true)).toBe(true);
  });
});

describe("network environment guards", () => {
  const base = {
    APP_URL: "https://isp.example.co.ke",
    DATABASE_URL: "postgresql://u:p@db:5432/cloudlink",
    AUTH_SECRET: "a-very-long-random-production-secret-0123456789",
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  };

  it("rejects public networks in the router allowlist", () => {
    expect(() => parseEnv({ ...base, APP_ENV: "development", MIKROTIK_ALLOWED_NETWORKS: "0.0.0.0/0" })).toThrow(/MIKROTIK_ALLOWED_NETWORKS/);
    expect(() => parseEnv({ ...base, APP_ENV: "development", MIKROTIK_ALLOWED_NETWORKS: "10.0.0.0/8,not-a-cidr" })).toThrow(/CIDR/);
    expect(parseEnv({ ...base, APP_ENV: "development", MIKROTIK_ALLOWED_NETWORKS: "10.8.0.0/16,127.0.0.0/8" }).MIKROTIK_ALLOWED_NETWORKS).toBe("10.8.0.0/16,127.0.0.0/8");
  });

  it("requires an allowlist for the RouterOS adapter in production and refuses loopback there", () => {
    const prod = { ...base, APP_ENV: "production", PAYMENT_ADAPTER: "disabled", MESSAGING_ADAPTER: "smtp", NETWORK_ADAPTER: "routeros", MIKROTIK_CONNECTION_MODE: "api-ssl" };
    expect(() => parseEnv(prod)).toThrow(/MIKROTIK_ALLOWED_NETWORKS: is required/);
    expect(() => parseEnv({ ...prod, MIKROTIK_ALLOWED_NETWORKS: "127.0.0.0/8" })).toThrow(/not a private network/);
    expect(parseEnv({ ...prod, MIKROTIK_ALLOWED_NETWORKS: "10.8.0.0/24" }).NETWORK_ADAPTER).toBe("routeros");
  });

  it("validates the RADIUS settings", () => {
    expect(() => parseEnv({ ...base, RADIUS_DATABASE_URL: "mysql://x" })).toThrow(/RADIUS_DATABASE_URL/);
    expect(() => parseEnv({ ...base, RADIUS_DB_SCHEMA: "radius; drop" })).toThrow(/RADIUS_DB_SCHEMA/);
  });
});

describe("adapter helpers", () => {
  it("converts RouterOS durations both ways", () => {
    expect(parseUptime("1w2d3h4m5s")).toBe(604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseUptime("45s")).toBe(45);
    expect(parseUptime("garbage")).toBeUndefined();
    expect(rosDuration(86400 + 3600 + 61)).toBe("1d1h1m1s");
    expect(rosDuration(3600)).toBe("1h");
    expect(rosDuration(0)).toBe("0s");
    expect(kbpsToRate(10240)).toBe("10M");
    expect(kbpsToRate(512)).toBe("512k");
    expect(kbpsToRate(null)).toBeNull();
  });

  it("classifies failures for the retry policy", () => {
    const run = (err: unknown) => {
      try {
        classify(err);
      } catch (e) {
        return e;
      }
    };
    expect(run(new RouterOsConnectionError("t", "TIMEOUT"))).toBeInstanceOf(RetryableError);
    expect(run(new RouterOsConnectionError("t", "REFUSED"))).toMatchObject({ code: "ROUTER_REFUSED" });
    expect(run(new RouterOsTrapError("bad login", "auth"))).toMatchObject({ code: "ROUTER_AUTH" });
    expect(run(new RouterOsTrapError("input does not match any value of profile"))).toBeInstanceOf(PermanentError);
    expect(run(new RouterOsInputError("x"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(run(new Error("boom"))).toBeInstanceOf(RetryableError);
  });
});
