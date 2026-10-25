import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Wallet } from "lucide-react";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getInvoice } from "@/server/services/invoices";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/feedback";
import { buttonVariants } from "@/components/ui/button";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { InvoiceStatusBadge, METHOD_LABEL, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";
import { InvoiceActions } from "./actions";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("invoices.read");
  if (!allowed) return <Forbidden what="invoices" />;
  let inv;
  try {
    inv = await getInvoice(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  const m = (v: { toString(): string }) => formatMoney(v.toString(), inv.currency);
  const open = inv.status === "OPEN" || inv.status === "PARTIALLY_PAID";
  const creditable = Number(inv.total.toString()) - inv.creditNotes.reduce((a, c) => a + Number(c.total.toString()), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : "Draft invoice"}
        description={`${inv.subscriber.displayName} · ${inv.subscriber.accountNumber} · ${humanize(inv.source)}`}
        actions={
          <>
            <a href={`/api/v1/invoices/${inv.id}/pdf`} target="_blank" rel="noopener" className={buttonVariants({ variant: "secondary" })}>
              <Download /> PDF
            </a>
            {open && ctx.permissions.has("payments.record") ? (
              <Link href={`/payments/new?subscriberId=${inv.subscriber.id}&invoiceId=${inv.id}`} className={buttonVariants()}>
                <Wallet /> Record payment
              </Link>
            ) : null}
          </>
        }
      />
      {inv.status === "VOID" ? (
        <Alert tone="neutral" title="This invoice is void">
          {inv.voidReason} · {formatDateTime(inv.voidedAt, tz)}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Lines</CardTitle>
            <InvoiceStatusBadge status={inv.status} overdue={inv.overdue} />
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <Th>Description</Th>
                <Th className="text-right">Qty</Th>
                <Th className="text-right">Unit price</Th>
                <Th className="text-right">Tax</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </THead>
            <TBody>
              {inv.lines.map((l) => (
                <Tr key={l.id}>
                  <Td label="Description">
                    {l.description}
                    {Number(l.discount.toString()) > 0 ? <span className="block text-xs text-muted-foreground">Discount {m(l.discount)}</span> : null}
                  </Td>
                  <Td label="Qty" className="tabular md:text-right">
                    {Number(l.quantity.toString())}
                  </Td>
                  <Td label="Unit price" className="tabular md:text-right">
                    {m(l.unitPrice)}
                  </Td>
                  <Td label="Tax" className="tabular md:text-right">
                    {Number(l.taxRate.toString()) ? `${Number(l.taxRate.toString())}% · ${m(l.taxAmount)}` : "—"}
                  </Td>
                  <Td label="Amount" className="tabular md:text-right">
                    {m(l.lineTotal)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <CardContent>
            <dl className="ml-auto max-w-xs space-y-1 text-sm">
              <Sum label="Subtotal" value={m(inv.subtotal)} />
              {Number(inv.discountTotal.toString()) ? <Sum label="Discount" value={`-${m(inv.discountTotal)}`} /> : null}
              <Sum label="Tax" value={m(inv.taxTotal)} />
              <Sum label="Total" value={m(inv.total)} strong />
              <Sum label="Paid" value={`-${m(inv.amountPaid)}`} />
              {Number(inv.amountCredited.toString()) ? <Sum label="Credited" value={`-${m(inv.amountCredited)}`} /> : null}
              <Sum label="Balance due" value={inv.status === "VOID" ? "—" : m(inv.balanceDue)} strong />
            </dl>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Subscriber">
                <Link href={`/subscribers/${inv.subscriber.id}`} className="text-accent hover:underline">
                  {inv.subscriber.displayName}
                </Link>
              </Detail>
              <Detail label="Issued">{formatDate(inv.issuedAt, tz)}</Detail>
              <Detail label="Due">{formatDate(inv.dueAt, tz)}</Detail>
              {inv.billingPeriodStart ? (
                <Detail label="Service period">
                  {formatDate(inv.billingPeriodStart, tz)} → {formatDate(inv.billingPeriodEnd, tz)}
                </Detail>
              ) : null}
              {inv.paidAt ? <Detail label="Paid">{formatDate(inv.paidAt, tz)}</Detail> : null}
              {inv.notes ? <p className="rounded-md bg-surface-muted p-2 text-xs">{inv.notes}</p> : null}
            </CardContent>
          </Card>
          <InvoiceActions
            invoice={{ id: inv.id, status: inv.status, number: inv.invoiceNumber, currency: inv.currency, balanceDue: inv.balanceDue.toString(), amountPaid: inv.amountPaid.toString(), amountCredited: inv.amountCredited.toString(), creditable: creditable.toFixed(2) }}
            can={{ issue: ctx.permissions.has("invoices.issue"), write: ctx.permissions.has("invoices.write"), credit: ctx.permissions.has("credit_notes.create") }}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payments and credits</CardTitle>
        </CardHeader>
        {inv.allocations.length === 0 && inv.creditNotes.length === 0 ? (
          <CardContent className="text-sm text-muted-foreground">Nothing applied yet.</CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Reference</Th>
                <Th>Status</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </THead>
            <TBody>
              {inv.allocations.map((a) => (
                <Tr key={a.id}>
                  <Td label="Date">{formatDateTime(a.createdAt, tz)}</Td>
                  <Td label="Type">Payment · {METHOD_LABEL[a.payment.method]}</Td>
                  <Td label="Reference">
                    <Link href={`/payments/${a.payment.id}`} className="font-mono text-xs text-accent hover:underline">
                      {a.payment.receiptNumber}
                    </Link>
                  </Td>
                  <Td label="Status">{a.status === "ACTIVE" ? "Applied" : `Reversed${a.reversalReason ? `: ${a.reversalReason}` : ""}`}</Td>
                  <Td label="Amount" className={`tabular md:text-right ${a.status === "REVERSED" ? "text-muted-foreground line-through" : ""}`}>
                    {m(a.amount)}
                  </Td>
                </Tr>
              ))}
              {inv.creditNotes.map((c) => (
                <Tr key={c.id}>
                  <Td label="Date">{formatDateTime(c.issuedAt, tz)}</Td>
                  <Td label="Type">Credit note</Td>
                  <Td label="Reference" className="font-mono text-xs">
                    {c.creditNoteNumber}
                  </Td>
                  <Td label="Status">{c.reason}</Td>
                  <Td label="Amount" className="tabular md:text-right">
                    {m(c.total)}
                    {Number(c.toCustomerCredit.toString()) > 0 ? <span className="block text-xs text-muted-foreground">{m(c.toCustomerCredit)} to account credit</span> : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Sum({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "border-t border-border pt-1 font-semibold" : "text-muted-foreground"}`}>
      <dt>{label}</dt>
      <dd className="tabular text-foreground">{value}</dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
