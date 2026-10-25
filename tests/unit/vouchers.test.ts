import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, formatCode, generateCode, hashCode, isPlausibleCode, normalizeCode } from "@/server/domain/vouchers";

describe("voucher codes", () => {
  it("uses only unambiguous characters and the requested length", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode(10);
      expect(c).toHaveLength(10);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it("normalises case, spaces and hyphens", () => {
    expect(normalizeCode(" abcd-efgh jk ")).toBe("ABCDEFGHJK");
    expect(formatCode("ABCDEFGHJK")).toBe("ABCD-EFGH-JK");
    expect(isPlausibleCode("ABCDEFGHJK")).toBe(true);
    expect(isPlausibleCode("ABC0EFGHJK")).toBe(false);
  });

  it("hashes per organization so equal codes in two tenants never collide", () => {
    expect(hashCode("org-a", "abcd-efgh-jk")).toBe(hashCode("org-a", "ABCDEFGHJK"));
    expect(hashCode("org-a", "ABCDEFGHJK")).not.toBe(hashCode("org-b", "ABCDEFGHJK"));
    expect(hashCode("org-a", "ABCDEFGHJK")).toMatch(/^[0-9a-f]{64}$/);
  });
});
