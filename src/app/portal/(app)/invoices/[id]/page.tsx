import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { z } from "zod";
import { getCustomerContext } from "@/server/portal/page";
import { getCustomerInvoice } from "@/server/portal/services";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { InvoiceStatusBadge, METHOD_LABEL } from "@/components/status";
import { formatDate, formatMoney } from "@/lib/utils";
import { db } from "@/server/db/client";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { PortalPayForm } from "../../pay-form";
import { PaymentMethodsList } from "../../payment-methods";
import { activePaymentInstructions } from "@/server/services/payment-methods";

export const metadata: Metadata = { title: "Invoice · Customer portal" };

export default async function PortalInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await getCustomerContext();
  let inv;
  try {
    inv = await getCustomerInvoice(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  const m = (v: { toString(): string }) => formatMoney(v.toString(), inv.currency);
  const overdue = (inv.status === "OPEN" || inv.status === "PARTIALLY_PAID") && !!inv.dueAt && inv.dueAt < new Date();
  const paymentMode = paymentAdapterMode();
  const open = inv.status === "OPEN" || inv.status === "PARTIALLY_PAID";
  const payable = inv.status !== "VOID" && inv.status !== "DRAFT" && paymentMode !== "disabled" && inv.currency === "KES";
  const payer = payable ? await db.subscriber.findUnique({ where: { id: ctx.subscriberId }, select: { phone: true, accountNumber: true } }) : null;
  const methods = payer ? await activePaymentInstructions(ctx.organizationId, payer.accountNumber) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Invoice {inv.invoiceNumber}</h1>
          <p className="text-sm text-muted-foreground">
            Issued {formatDate(inv.issuedAt, tz)} · due {formatDate(inv.dueAt, tz)}
          </p>
        </div>
        <a href={`/api/v1/customer/invoices/${inv.id}/pdf`} target="_blank" rel="noopener" className={buttonVariants({ variant: "secondary" })}>
          <Download /> Download PDF
        </a>
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Details</CardTitle>
          <InvoiceStatusBadge status={inv.status} overdue={overdue} />
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {inv.lines.map((l) => (
            <div key={l.id} className="flex justify-between gap-4">
              <span>
                {l.description}
                {Number(l.quantity.toString()) !== 1 ? <span className="text-muted-foreground"> × {Number(l.quantity.toString())}</span> : null}
              </span>
              <span className="tabular whitespace-nowrap">{m(l.lineTotal)}</span>
            </div>
          ))}
          <div className="space-y-1 border-t border-border pt-3">
            <Row label="Total" value={m(inv.total)} strong />
            {inv.allocations.map((a) => (
              <Row key={a.id} label={`Paid ${formatDate(a.payment.receivedAt, tz)} · ${METHOD_LABEL[a.payment.method]} (${a.payment.receiptNumber})`} value={`-${m(a.amount)}`} />
            ))}
            {inv.creditNotes.map((c) => (
              <Row key={c.creditNoteNumber} label={`Credit ${c.creditNoteNumber}`} value={`-${m(c.total)}`} />
            ))}
            <Row label={inv.status === "VOID" ? "Void" : "Balance due"} value={inv.status === "VOID" ? "—" : m(inv.balanceDue)} strong />
          </div>
        </CardContent>
      </Card>
      {payable ? (
        <Card>
          <CardHeader>
            <CardTitle>Pay with M-Pesa</CardTitle>
          </CardHeader>
          <CardContent>
            <PortalPayForm phone={payer?.phone ?? ""} amount={Math.ceil(Number(inv.balanceDue.toString()))} invoiceId={inv.id} simulated={paymentMode === "mock"} closed={!open} />
            {open && methods.length ? (
              <div className="mt-4 space-y-2 border-t border-border pt-4">
                <p className="text-sm font-medium">Other ways to pay</p>
                <PaymentMethodsList methods={methods} accountNumber={payer?.accountNumber ?? ""} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "font-semibold" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="tabular text-foreground">{value}</span>
    </div>
  );
}
