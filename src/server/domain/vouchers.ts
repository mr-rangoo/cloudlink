import { createHmac, hkdfSync, randomInt } from "node:crypto";

/**
 * Voucher codes: random characters from an unambiguous alphabet (no 0/O, 1/I/L). With 10 characters there are
 * 31^10 ≈ 8×10^14 combinations, so guessing against the rate-limited redemption endpoint is impractical.
 * Codes are matched case-insensitively and ignoring spaces/hyphens.
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateCode(length = 10): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

export function isPlausibleCode(code: string): boolean {
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6,16}$/.test(code);
}

/** Display grouping, e.g. ABCD-EFGH-JK. */
export function formatCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

let derivedKey: Buffer | undefined;
function hashKey(): Buffer {
  if (!derivedKey) {
    const raw = process.env.APP_ENCRYPTION_KEY;
    if (!raw) throw new Error("APP_ENCRYPTION_KEY is not configured");
    derivedKey = Buffer.from(hkdfSync("sha256", Buffer.from(raw, "base64"), Buffer.from("cloudlink"), Buffer.from("voucher-code-v1"), 32));
  }
  return derivedKey;
}

/** Keyed hash used for lookup; scoped by organization so identical codes in two tenants never collide. */
export function hashCode(organizationId: string, code: string): string {
  return createHmac("sha256", hashKey()).update(`${organizationId}:${normalizeCode(code)}`).digest("hex");
}
