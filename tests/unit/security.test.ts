import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, randomToken, safeEqual, sha256, verifyPassword } from "@/server/security/crypto";
import { redactMetadata } from "@/server/audit/audit";
import { maskContact } from "@/server/observability/logger";

describe("password hashing", () => {
  it("verifies the correct password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("salts hashes so identical passwords differ", async () => {
    expect(await hashPassword("same-password-1")).not.toEqual(await hashPassword("same-password-1"));
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips with AES-256-GCM", () => {
    const env = encryptSecret("router-password-123");
    expect(env).not.toContain("router-password-123");
    expect(decryptSecret(env)).toBe("router-password-123");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptSecret("a")).not.toEqual(encryptSecret("a"));
  });

  it("detects tampering and wrong associated data", () => {
    const env = encryptSecret("secret", "router:1");
    const parts = env.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64")].join(":");
    expect(() => decryptSecret(tampered, "router:1")).toThrow();
    expect(() => decryptSecret(env, "router:2")).toThrow();
  });
});

describe("tokens", () => {
  it("generates url-safe random tokens and stable hashes", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(sha256(t)).toEqual(sha256(t));
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("audit metadata redaction", () => {
  it("removes secrets at any depth", () => {
    const out = redactMetadata({
      name: "Router A",
      password: "p",
      nested: { apiKey: "k", passkey: "pk", token: "t", keep: 1 },
      list: [{ secret: "s", ok: true }],
    }) as Record<string, unknown>;
    expect(out).toEqual({
      name: "Router A",
      password: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", passkey: "[REDACTED]", token: "[REDACTED]", keep: 1 },
      list: [{ secret: "[REDACTED]", ok: true }],
    });
  });
});

describe("contact masking", () => {
  it("masks phone numbers and emails", () => {
    expect(maskContact("254712345678")).toBe("2547***678");
    expect(maskContact("jane@example.com")).toBe("ja***@example.com");
    expect(maskContact(null)).toBe("");
  });
});
