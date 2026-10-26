import "server-only";
import { db } from "@/server/db/client";
import type { ActorContext } from "@/server/auth/context";
import { getInvoice } from "@/server/services/invoices";
import { getPayment } from "@/server/services/payments";
import { getBillingSettings } from "@/server/services/invoices";
import { renderInvoicePdf, renderReceiptPdf } from "@/server/documents/pdf";
import { activePaymentInstructions } from "@/server/services/payment-methods";

async function orgHeader(organizationId: string) {
  const [org, settings] = await Promise.all([db.organization.findUniqueOrThrow({ where: { id: organizationId } }), getBillingSettings(db, organizationId)]);
  return {
    name: org.name,
    legalName: settings.legalName,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    taxPin: settings.taxPin,
    taxLabel: settings.taxLabel,
    footer: settings.invoiceFooter,
    timezone: org.timezone,
  };
}

/** Invoice PDF. Permission and tenant/branch checks happen in getInvoice. */
export async function invoicePdf(ctx: ActorContext, id: string) {
  const inv = await getInvoice(ctx, id);
  const addr = inv.subscriber.addresses[0];
  const pdf = await renderInvoicePdf({
    org: await orgHeader(ctx.organizationId),
    invoice: inv,
    subscriber: { ...inv.subscriber, address: addr ? [addr.line1, addr.area, addr.town].filter(Boolean).join(", ") : null },
    howToPay: await activePaymentInstructions(ctx.organizationId, inv.subscriber.accountNumber),
  });
  return { pdf, filename: `${inv.invoiceNumber ?? "draft-invoice"}.pdf` };
}

/** Receipt PDF for a confirmed (or reversed) payment. */
export async function receiptPdf(ctx: ActorContext, id: string) {
  const p = await getPayment(ctx, id);
  const pdf = await renderReceiptPdf({
    org: await orgHeader(ctx.organizationId),
    payment: {
      ...p,
      allocations: p.allocations.map((a) => ({ invoiceNumber: a.invoice.invoiceNumber, amount: a.amount, status: a.status })),
      refunded: p.refundedAmount,
    },
    subscriber: p.subscriber,
  });
  return { pdf, filename: `${p.receiptNumber ?? "receipt"}.pdf` };
}

export function pdfResponse(pdf: Buffer, filename: string, inline = true): Response {
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}
