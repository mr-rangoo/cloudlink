/**
 * Normalise a phone number to E.164 digits without "+".
 * Kenyan formats (07xx, 01xx, 7xx, 1xx, 254…, +254…) become 2547XXXXXXXX / 2541XXXXXXXX.
 * Other international numbers must be given with a leading "+" or 00 prefix.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);

  if (!hasPlus) {
    if (/^0[17]\d{8}$/.test(digits)) digits = `254${digits.slice(1)}`;
    else if (/^[17]\d{8}$/.test(digits)) digits = `254${digits}`;
  }
  if (digits.startsWith("254")) return /^254[17]\d{8}$/.test(digits) ? digits : null;
  if (hasPlus && /^[1-9]\d{7,14}$/.test(digits)) return digits;
  return null;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  return v.length ? v : null;
}

/** Display a stored phone as +254 712 345 678. */
export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  if (/^254\d{9}$/.test(digits)) return `+254 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  return `+${digits}`;
}
