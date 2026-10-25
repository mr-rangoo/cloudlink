import "server-only";
import PDFDocument from "pdfkit";
import { formatPhone } from "@/server/domain/contact";

/**
 * PDF invoices, receipts and credit notes rendered on demand from persisted records (never from client input).
 * Uses PDFKit's built-in Helvetica so no font files need to be shipped.
 */
type Money = { toString(): string };

interface OrgHeader {
  name: string;
  legalName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  taxPin?: string | null;
  taxLabel: string;
  footer?: string | null;
  timezone: string;
}

const ACCENT = "#1d6fe8";
const MUTED = "#5b6b82";
const BORDER = "#e2e8f0";

export function money(v: Money | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  const s = v.toString();
  const neg = s.startsWith("-");
  const [i = "0", f = ""] = s.replace("-", "").split(".");
  return `${neg ? "-" : ""}${currency} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(f + "00").slice(0, 2)}`;
}

function date(d: Date | null | undefined, tz: string): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: tz }).format(d);
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, org: OrgHeader, title: string, number: string) {
  doc.fillColor(ACCENT).fontSize(20).font("Helvetica-Bold").text(org.legalName || org.name, 50, 50, { width: 300 });
  doc.fillColor(MUTED).fontSize(9).font("Helvetica");
  const lines = [org.address, org.phone, org.email, org.taxPin ? `${org.taxLabel} PIN: ${org.taxPin}` : null].filter(Boolean) as string[];
  lines.forEach((l) => doc.text(l, { width: 300 }));
  doc.fillColor("#0f172a").fontSize(18).font("Helvetica-Bold").text(title, 350, 50, { width: 195, align: "right" });
  doc.fontSize(10).font("Helvetica").fillColor(MUTED).text(number, 350, 74, { width: 195, align: "right" });
  doc.moveTo(50, 130).lineTo(545, 130).strokeColor(BORDER).stroke();
}

function kv(doc: PDFKit.PDFDocument, x: number, y: number, label: string, value: string, width = 160) {
  doc.fontSize(8).fillColor(MUTED).font("Helvetica").text(label.toUpperCase(), x, y, { width });
  doc.fontSize(10).fillColor("#0f172a").text(value, x, y + 11, { width });
}

function footer(doc: PDFKit.PDFDocument, org: OrgHeader, note: string) {
  const y = 770;
  doc.moveTo(50, y - 8).lineTo(545, y - 8).strokeColor(BORDER).stroke();
  doc.fontSize(8).fillColor(MUTED).font("Helvetica").text([org.footer, note].filter(Boolean).join("  ·  "), 50, y, { width: 495, align: "center" });
}

export interface InvoicePdfData {
  org: OrgHeader;
  invoice: {
    invoiceNumber: string | null;
    status: string;
    currency: string;
    issuedAt: Date | null;
    dueAt: Date | null;
    billingPeriodStart: Date | null;
    billingPeriodEnd: Date | null;
    subtotal: Money;
    discountTotal: Money;
    taxTotal: Money;
    total: Money;
    amountPaid: Money;
    amountCredited: Money;
    balanceDue: Money;
    notes: string | null;
    lines: Array<{ description: string; quantity: Money; unitPrice: Money; discount: Money; taxRate: Money; taxAmount: Money; lineTotal: Money }>;
  };
  subscriber: { displayName: string; accountNumber: string; phone: string; email: string | null; address?: string | null };
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const { org, invoice: inv, subscriber } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Invoice ${inv.invoiceNumber ?? "draft"}`, Author: org.name } });
  const title = Number(inv.taxTotal.toString()) > 0 ? "TAX INVOICE" : "INVOICE";
  header(doc, org, inv.status === "VOID" ? `${title} (VOID)` : title, inv.invoiceNumber ?? "DRAFT");

  kv(doc, 50, 145, "Bill to", `${subscriber.displayName}\nAccount ${subscriber.accountNumber}\n${formatPhone(subscriber.phone)}${subscriber.email ? `\n${subscriber.email}` : ""}${subscriber.address ? `\n${subscriber.address}` : ""}`, 220);
  kv(doc, 330, 145, "Issued", date(inv.issuedAt, org.timezone), 100);
  kv(doc, 445, 145, "Due", date(inv.dueAt, org.timezone), 100);
  if (inv.billingPeriodStart && inv.billingPeriodEnd) kv(doc, 330, 180, "Service period", `${date(inv.billingPeriodStart, org.timezone)} – ${date(inv.billingPeriodEnd, org.timezone)}`, 215);

  let y = 240;
  const cols = { desc: 50, qty: 300, price: 340, tax: 420, total: 470 };
  doc.rect(50, y, 495, 20).fill("#f1f4f9");
  doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold");
  doc.text("DESCRIPTION", cols.desc + 6, y + 6).text("QTY", cols.qty, y + 6, { width: 35, align: "right" }).text("UNIT PRICE", cols.price, y + 6, { width: 75, align: "right" });
  doc.text(org.taxLabel, cols.tax, y + 6, { width: 45, align: "right" }).text("AMOUNT", cols.total, y + 6, { width: 69, align: "right" });
  y += 26;
  doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
  for (const l of inv.lines) {
    const h = Math.max(doc.heightOfString(l.description, { width: 240 }), 12);
    doc.text(l.description, cols.desc + 6, y, { width: 240 });
    doc.text(Number(l.quantity.toString()).toString(), cols.qty, y, { width: 35, align: "right" });
    doc.text(money(l.unitPrice, ""), cols.price, y, { width: 75, align: "right" });
    doc.text(Number(l.taxRate.toString()) > 0 ? `${Number(l.taxRate.toString())}%` : "—", cols.tax, y, { width: 45, align: "right" });
    doc.text(money(l.lineTotal, ""), cols.total, y, { width: 69, align: "right" });
    if (Number(l.discount.toString()) > 0) {
      doc.fillColor(MUTED).fontSize(8).text(`Discount ${money(l.discount, inv.currency)}`, cols.desc + 6, y + h + 1);
      doc.fillColor("#0f172a").fontSize(9);
    }
    y += h + (Number(l.discount.toString()) > 0 ? 16 : 8);
    doc.moveTo(50, y - 3).lineTo(545, y - 3).strokeColor(BORDER).stroke();
  }

  y += 8;
  const row = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(bold ? "#0f172a" : MUTED).text(label, 330, y, { width: 120 });
    doc.fillColor("#0f172a").text(value, 450, y, { width: 95, align: "right" });
    y += bold ? 18 : 14;
  };
  row("Subtotal", money(inv.subtotal, inv.currency));
  if (Number(inv.discountTotal.toString()) > 0) row("Discount", `-${money(inv.discountTotal, inv.currency)}`);
  row(org.taxLabel, money(inv.taxTotal, inv.currency));
  row("Total", money(inv.total, inv.currency), true);
  if (Number(inv.amountPaid.toString()) > 0) row("Paid", `-${money(inv.amountPaid, inv.currency)}`);
  if (Number(inv.amountCredited.toString()) > 0) row("Credited", `-${money(inv.amountCredited, inv.currency)}`);
  row(inv.status === "VOID" ? "Balance (void)" : "Balance due", money(inv.status === "VOID" ? "0" : inv.balanceDue, inv.currency), true);

  if (inv.notes) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(inv.notes, 50, y + 10, { width: 260 });
  }
  footer(doc, org, `Pay with your account number ${subscriber.accountNumber} as the reference.`);
  return toBuffer(doc);
}

export interface ReceiptPdfData {
  org: OrgHeader;
  payment: {
    receiptNumber: string | null;
    method: string;
    providerTransactionId: string | null;
    amount: Money;
    currency: string;
    receivedAt: Date | null;
    status: string;
    payerName: string | null;
    allocations: Array<{ invoiceNumber: string | null; amount: Money; status: string }>;
    refunded: Money;
    unallocated: string;
  };
  subscriber: { displayName: string; accountNumber: string } | null;
}

export async function renderReceiptPdf(data: ReceiptPdfData): Promise<Buffer> {
  const { org, payment: p, subscriber } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Receipt ${p.receiptNumber ?? ""}`, Author: org.name } });
  header(doc, org, p.status === "REVERSED" ? "RECEIPT (REVERSED)" : "RECEIPT", p.receiptNumber ?? "—");
  kv(doc, 50, 145, "Received from", subscriber ? `${subscriber.displayName}\nAccount ${subscriber.accountNumber}` : p.payerName || "Unidentified payer", 240);
  kv(doc, 330, 145, "Date", date(p.receivedAt, org.timezone), 100);
  kv(doc, 445, 145, "Method", p.method.replace("_", " ").toLowerCase(), 100);
  if (p.providerTransactionId) kv(doc, 330, 180, "Reference", p.providerTransactionId, 215);

  doc.rect(50, 225, 495, 50).fill("#e7f0fe");
  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("AMOUNT RECEIVED", 66, 236);
  doc.fillColor("#0f172a").fontSize(20).font("Helvetica-Bold").text(money(p.amount, p.currency), 66, 248);

  let y = 300;
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#0f172a").text("Applied to", 50, y);
  y += 18;
  doc.font("Helvetica").fontSize(9);
  const active = p.allocations.filter((a) => a.status === "ACTIVE");
  if (!active.length) {
    doc.fillColor(MUTED).text("Not yet applied to an invoice; held as account credit.", 50, y);
    y += 14;
  }
  for (const a of active) {
    doc.fillColor("#0f172a").text(`Invoice ${a.invoiceNumber ?? ""}`, 50, y).text(money(a.amount, p.currency), 400, y, { width: 145, align: "right" });
    y += 14;
  }
  if (Number(p.refunded.toString()) > 0) {
    doc.fillColor(MUTED).text("Refunded", 50, y).text(money(p.refunded, p.currency), 400, y, { width: 145, align: "right" });
    y += 14;
  }
  if (Number(p.unallocated) > 0) {
    doc.fillColor(MUTED).text("Account credit", 50, y).text(money(p.unallocated, p.currency), 400, y, { width: 145, align: "right" });
  }
  footer(doc, org, "This receipt was generated from Cloudlink payment records.");
  return toBuffer(doc);
}
