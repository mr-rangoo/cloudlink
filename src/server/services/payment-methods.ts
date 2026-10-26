import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import type { CustomerPaymentMethod, Prisma } from "@/generated/prisma/client";

/**
 * Ways customers can pay, configured by the organization: M-Pesa paybill or till, bank transfer, cash, or other.
 * Shown (personalised with the customer's account number) in the portal, on invoices and to staff.
 * Online M-Pesa (STK Push) is configured separately under Integrations.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const common = { label: optText(60), instructions: optText(500), active: z.boolean().default(true) };

export const paymentMethodInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MPESA_PAYBILL"), paybill: z.string().trim().regex(/^\d{5,7}$/, "5–7 digits"), ...common }),
  z.object({ kind: z.literal("MPESA_TILL"), till: z.string().trim().regex(/^\d{5,8}$/, "5–8 digits"), ...common }),
  z.object({ kind: z.literal("BANK"), bankName: text(80), accountName: text(120), accountNumber: z.string().trim().regex(/^[A-Za-z0-9 -]{4,34}$/, "4–34 letters or digits"), branch: optText(80), swiftCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/, "8 or 11 characters").nullable().optional().or(z.literal("").transform(() => null)), ...common }),
  z.object({ kind: z.literal("CASH"), location: text(160), ...common }),
  z.object({ kind: z.literal("OTHER"), ...common, label: text(60), instructions: text(500) }),
]);
export type PaymentMethodInput = z.infer<typeof paymentMethodInput>;

export const paymentMethodUpdate = z.object({ active: z.boolean().optional(), sortOrder: z.coerce.number().int().min(0).max(1000).optional() });

const DEFAULT_LABEL: Record<string, string> = { MPESA_PAYBILL: "M-Pesa Paybill", MPESA_TILL: "M-Pesa Till (Buy Goods)", BANK: "Bank transfer", CASH: "Cash at our office", OTHER: "Other" };

function detailsOf(input: PaymentMethodInput): Record<string, string | null> {
  switch (input.kind) {
    case "MPESA_PAYBILL":
      return { paybill: input.paybill };
    case "MPESA_TILL":
      return { till: input.till };
    case "BANK":
      return { bankName: input.bankName, accountName: input.accountName, accountNumber: input.accountNumber, branch: input.branch ?? null, swiftCode: input.swiftCode ?? null };
    case "CASH":
      return { location: input.location };
    default:
      return {};
  }
}

export interface PaymentInstructions {
  id: string;
  kind: string;
  label: string;
  lines: string[];
  note: string | null;
}

/** Customer-facing instructions, personalised with the account number where the method supports a reference. */
export function instructionsFor(m: Pick<CustomerPaymentMethod, "id" | "kind" | "label" | "details" | "instructions">, accountNumber: string | null): PaymentInstructions {
  const d = (m.details ?? {}) as Record<string, string | null>;
  const account = accountNumber ? [`Account number: ${accountNumber}`] : ["Account number: your Cloudlink account number"];
  let lines: string[];
  switch (m.kind) {
    case "MPESA_PAYBILL":
      lines = ["M-Pesa → Lipa na M-Pesa → Pay Bill", `Business number: ${d.paybill}`, ...account];
      break;
    case "MPESA_TILL":
      lines = ["M-Pesa → Lipa na M-Pesa → Buy Goods and Services", `Till number: ${d.till}`, "Pay from the phone number registered on your account so we can match the payment."];
      break;
    case "BANK":
      lines = [`Bank: ${d.bankName}`, `Account name: ${d.accountName}`, `Account number: ${d.accountNumber}`, ...(d.branch ? [`Branch: ${d.branch}`] : []), ...(d.swiftCode ? [`SWIFT: ${d.swiftCode}`] : []), accountNumber ? `Reference: ${accountNumber}` : "Reference: your account number"];
      break;
    case "CASH":
      lines = [`Pay at: ${d.location}`, "Ask for a receipt."];
      break;
    default:
      lines = [];
  }
  return { id: m.id, kind: m.kind, label: m.label, lines, note: m.instructions };
}

export async function listPaymentMethods(ctx: StaffContext) {
  requirePermission(ctx, "settings.write");
  return db.customerPaymentMethod.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

/** Active methods for display to customers (portal, invoices). */
export async function activePaymentInstructions(organizationId: string, accountNumber: string | null): Promise<PaymentInstructions[]> {
  const rows = await db.customerPaymentMethod.findMany({ where: { organizationId, active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.map((m) => instructionsFor(m, accountNumber));
}

export async function createPaymentMethod(ctx: StaffContext, raw: z.input<typeof paymentMethodInput>) {
  requirePermission(ctx, "settings.write");
  const input = paymentMethodInput.parse(raw);
  const count = await db.customerPaymentMethod.count({ where: { organizationId: ctx.organizationId } });
  if (count >= 20) throw new AppError("INVALID_STATE", "Up to 20 payment methods can be listed.");
  const row = await db.customerPaymentMethod.create({
    data: { organizationId: ctx.organizationId, kind: input.kind, label: input.label ?? DEFAULT_LABEL[input.kind]!, details: detailsOf(input) as Prisma.InputJsonValue, instructions: input.instructions ?? null, active: input.active, sortOrder: count },
  });
  await audit(ctx, { action: "settings.payment_method.create", entityType: "payment_method", entityId: row.id, metadata: { kind: row.kind, label: row.label } });
  return row;
}

export async function replacePaymentMethod(ctx: StaffContext, id: string, raw: z.input<typeof paymentMethodInput>) {
  requirePermission(ctx, "settings.write");
  const input = paymentMethodInput.parse(raw);
  const existing = await db.customerPaymentMethod.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!existing) throw notFound("payment method");
  const row = await db.customerPaymentMethod.update({
    where: { id },
    data: { kind: input.kind, label: input.label ?? DEFAULT_LABEL[input.kind]!, details: detailsOf(input) as Prisma.InputJsonValue, instructions: input.instructions ?? null, active: input.active },
  });
  await audit(ctx, { action: "settings.payment_method.update", entityType: "payment_method", entityId: id, metadata: { kind: row.kind, label: row.label, active: row.active } });
  return row;
}

export async function updatePaymentMethod(ctx: StaffContext, id: string, raw: z.input<typeof paymentMethodUpdate>) {
  requirePermission(ctx, "settings.write");
  const input = paymentMethodUpdate.parse(raw);
  const existing = await db.customerPaymentMethod.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!existing) throw notFound("payment method");
  const row = await db.customerPaymentMethod.update({ where: { id }, data: input });
  await audit(ctx, { action: "settings.payment_method.update", entityType: "payment_method", entityId: id, metadata: input });
  return row;
}

export async function deletePaymentMethod(ctx: StaffContext, id: string) {
  requirePermission(ctx, "settings.write");
  const existing = await db.customerPaymentMethod.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!existing) throw notFound("payment method");
  await db.customerPaymentMethod.delete({ where: { id } });
  await audit(ctx, { action: "settings.payment_method.delete", entityType: "payment_method", entityId: id, metadata: { kind: existing.kind, label: existing.label } });
  return { ok: true };
}
