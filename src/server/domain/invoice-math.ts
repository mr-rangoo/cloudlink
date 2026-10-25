import Decimal from "decimal.js";
import { D, type DecimalValue } from "@/server/domain/money";

/**
 * Invoice arithmetic (pure, decimal-only).
 * Per line: subtotal = round2(quantity × unitPrice); taxable = subtotal − discount;
 * tax = round2(taxable × rate / 100); total = taxable + tax. Rounding is half-up to cents, applied per line,
 * and invoice totals are the sum of the rounded line values (so lines always add up to the total shown).
 * Prices are tax-exclusive.
 */
export interface LineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  discount?: string;
  taxRate?: string;
}

export interface ComputedLine {
  description: string;
  quantity: DecimalValue;
  unitPrice: DecimalValue;
  discount: DecimalValue;
  taxRate: DecimalValue;
  lineSubtotal: DecimalValue;
  taxAmount: DecimalValue;
  lineTotal: DecimalValue;
}

export interface InvoiceTotals {
  subtotal: DecimalValue;
  discountTotal: DecimalValue;
  taxTotal: DecimalValue;
  total: DecimalValue;
}

const r2 = (v: DecimalValue) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export class InvoiceMathError extends Error {}

export function computeLine(line: LineInput): ComputedLine {
  const quantity = new D(line.quantity);
  const unitPrice = new D(line.unitPrice);
  const discount = new D(line.discount ?? "0");
  const taxRate = new D(line.taxRate ?? "0");
  if (quantity.lte(0)) throw new InvoiceMathError("Quantity must be greater than zero.");
  if (unitPrice.lt(0)) throw new InvoiceMathError("Unit price cannot be negative.");
  if (discount.lt(0)) throw new InvoiceMathError("Discount cannot be negative.");
  if (taxRate.lt(0) || taxRate.gt(100)) throw new InvoiceMathError("Tax rate must be between 0 and 100.");
  const lineSubtotal = r2(quantity.mul(unitPrice));
  if (discount.gt(lineSubtotal)) throw new InvoiceMathError("Discount cannot exceed the line amount.");
  const taxable = lineSubtotal.minus(discount);
  const taxAmount = r2(taxable.mul(taxRate).div(100));
  return { description: line.description, quantity, unitPrice, discount: r2(discount), taxRate, lineSubtotal, taxAmount, lineTotal: taxable.plus(taxAmount) };
}

export function computeTotals(lines: ComputedLine[]): InvoiceTotals {
  const sum = (pick: (l: ComputedLine) => DecimalValue) => lines.reduce<DecimalValue>((acc, l) => acc.plus(pick(l)), new D(0));
  return { subtotal: sum((l) => l.lineSubtotal), discountTotal: sum((l) => l.discount), taxTotal: sum((l) => l.taxAmount), total: sum((l) => l.lineTotal) };
}

/** Allocate `amount` across invoices in the given order (callers pass oldest first). */
export function allocateInOrder(amount: DecimalValue, invoices: Array<{ id: string; balanceDue: DecimalValue }>): Array<{ invoiceId: string; amount: DecimalValue }> {
  let remaining = amount;
  const out: Array<{ invoiceId: string; amount: DecimalValue }> = [];
  for (const inv of invoices) {
    if (remaining.lte(0)) break;
    if (inv.balanceDue.lte(0)) continue;
    const take = Decimal.min(remaining, inv.balanceDue) as DecimalValue;
    out.push({ invoiceId: inv.id, amount: new D(take) });
    remaining = remaining.minus(take);
  }
  return out;
}

/**
 * Split a gross credit-note amount into net and tax in the invoice's tax proportion, and into the part that
 * reduces the invoice balance versus the part credited to the customer (when the invoice is already settled).
 */
export function splitCreditNote(amount: DecimalValue, invoice: { total: DecimalValue; taxTotal: DecimalValue; balanceDue: DecimalValue }) {
  const tax = invoice.total.gt(0) ? r2(amount.mul(invoice.taxTotal).div(invoice.total)) : new D(0);
  const net = amount.minus(tax);
  const appliedToInvoice = Decimal.min(amount, invoice.balanceDue) as DecimalValue;
  return { net, tax, appliedToInvoice: new D(appliedToInvoice), toCustomerCredit: amount.minus(appliedToInvoice) };
}

/** Status implied by the settlement figures (DRAFT and VOID are set explicitly, never derived). */
export function settledStatus(total: DecimalValue, balanceDue: DecimalValue): "OPEN" | "PARTIALLY_PAID" | "PAID" {
  if (balanceDue.lte(0)) return "PAID";
  if (balanceDue.lt(total)) return "PARTIALLY_PAID";
  return "OPEN";
}
