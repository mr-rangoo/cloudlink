import { z } from "zod";
import { toWallTime } from "@/server/domain/time";
import { normalizePhone } from "@/server/domain/contact";

/**
 * Pure M-Pesa (Safaricom Daraja) rules, kept separate from HTTP so they can be unit-tested.
 * Sources: Safaricom Daraja documentation for Lipa Na M-Pesa Online (STK Push), STK Push Query and C2B.
 */

export const MPESA_TIMEZONE = "Africa/Nairobi";
/** Per-transaction ceiling for customer payments (KES). Daraja rejects larger amounts. */
export const MPESA_MAX_AMOUNT = 250_000;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Daraja timestamp: YYYYMMDDHHmmss in East Africa Time. */
export function darajaTimestamp(now: Date): string {
  const w = toWallTime(now, MPESA_TIMEZONE);
  return `${w.year}${pad(w.month)}${pad(w.day)}${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
}

/** STK password: base64(BusinessShortCode + Passkey + Timestamp). */
export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

/** Parse a Daraja "YYYYMMDDHHmmss" EAT timestamp (callbacks send it as a number). EAT is UTC+3 with no DST. */
export function parseDarajaTimestamp(value: string | number | undefined | null): Date | null {
  if (value === undefined || value === null) return null;
  const s = String(value);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h - 3, mi, se));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** M-Pesa MSISDN (2547XXXXXXXX or 2541XXXXXXXX), or null when the number cannot receive an STK prompt. */
export function toMsisdn(phone: string | null | undefined): string | null {
  const n = normalizePhone(phone);
  return n && /^254[17]\d{8}$/.test(n) ? n : null;
}

/** Mask a phone number for display and logs: 254712***678. */
export function maskMsisdn(msisdn: string): string {
  return msisdn.length >= 9 ? `${msisdn.slice(0, 6)}***${msisdn.slice(-3)}` : "***";
}

/** STK amounts are whole shillings between 1 and the per-transaction limit. */
export function stkAmountProblem(amount: number): string | null {
  if (!Number.isInteger(amount)) return "M-Pesa requests must be whole shillings.";
  if (amount < 1) return "The amount must be at least KES 1.";
  if (amount > MPESA_MAX_AMOUNT) return `M-Pesa limits a single payment to KES ${MPESA_MAX_AMOUNT.toLocaleString("en-KE")}.`;
  return null;
}

/** AccountReference ≤ 12 characters and TransactionDesc ≤ 13 characters (Daraja limits); letters, digits and dashes. */
export function stkReference(value: string, max = 12): string {
  return value.replace(/[^A-Za-z0-9-]/g, "").slice(0, max) || "PAYMENT";
}

export type MpesaOutcome = "SUCCESS" | "CANCELLED" | "EXPIRED" | "FAILED" | "PENDING";

/** Map an STK result code (callback or query) to an outcome. */
export function stkOutcome(resultCode: string | number): MpesaOutcome {
  const code = String(resultCode);
  if (code === "0") return "SUCCESS";
  if (code === "1032") return "CANCELLED"; // request cancelled by the user
  if (code === "1037" || code === "1019") return "EXPIRED"; // no response from the user / transaction expired
  return "FAILED"; // e.g. 1 insufficient balance, 2001 wrong PIN, 1001 subscriber busy, 1025/9999 errors
}

const OUTCOME_MESSAGE: Record<string, string> = {
  "0": "Payment received.",
  "1": "The M-Pesa balance was not enough for this payment.",
  "1001": "Another M-Pesa transaction was in progress on this phone. Try again in a minute.",
  "1019": "The payment request expired before it was completed.",
  "1032": "The payment request was cancelled on the phone.",
  "1037": "The phone could not be reached or the customer did not respond in time.",
  "2001": "The M-Pesa PIN entered was incorrect.",
};

export function stkMessage(resultCode: string | number, fallback?: string): string {
  return OUTCOME_MESSAGE[String(resultCode)] ?? fallback ?? "M-Pesa could not complete the payment.";
}

// ───────── Callback payloads ─────────

const metadataItem = z.object({ Name: z.string(), Value: z.union([z.string(), z.number()]).optional() });

export const stkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().min(1).max(100),
      CheckoutRequestID: z.string().min(1).max(100),
      ResultCode: z.union([z.number(), z.string()]),
      ResultDesc: z.string().max(500).optional().default(""),
      CallbackMetadata: z.object({ Item: z.array(metadataItem).max(20) }).optional(),
    }),
  }),
});
export type StkCallback = z.infer<typeof stkCallbackSchema>["Body"]["stkCallback"];

export interface StkSuccessDetails {
  amount: number;
  receipt: string;
  transactionDate: Date | null;
  phone: string | null;
}

/** Extract the success metadata; null when required items are missing or malformed. */
export function stkSuccessDetails(cb: StkCallback): StkSuccessDetails | null {
  const items = cb.CallbackMetadata?.Item ?? [];
  const get = (name: string) => items.find((i) => i.Name === name)?.Value;
  const amount = Number(get("Amount"));
  const receipt = String(get("MpesaReceiptNumber") ?? "").toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z0-9]{8,20}$/.test(receipt)) return null;
  const phone = get("PhoneNumber");
  return { amount, receipt, transactionDate: parseDarajaTimestamp(get("TransactionDate") as string | number | undefined), phone: phone === undefined ? null : String(phone) };
}

export const c2bConfirmationSchema = z.object({
  TransactionType: z.string().max(40).optional().default(""),
  TransID: z.string().regex(/^[A-Za-z0-9]{8,20}$/),
  TransTime: z.union([z.string(), z.number()]),
  TransAmount: z.union([z.string(), z.number()]),
  BusinessShortCode: z.union([z.string(), z.number()]),
  BillRefNumber: z.string().max(100).optional().default(""),
  InvoiceNumber: z.string().max(100).optional().default(""),
  MSISDN: z.union([z.string(), z.number()]).optional(),
  FirstName: z.string().max(100).optional().default(""),
  MiddleName: z.string().max(100).optional().default(""),
  LastName: z.string().max(100).optional().default(""),
});
export type C2bConfirmation = z.infer<typeof c2bConfirmationSchema>;

/** Normalise the account reference a payer typed (case, spaces, dashes). */
export function normaliseBillRef(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}
