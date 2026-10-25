import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getPayment } from "@/server/services/payments";
import { db } from "@/server/db/client";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/feedback";
import { buttonVariants } from "@/components/ui/button";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { METHOD_LABEL, PaymentStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";
import { PaymentActions, ReverseAllocationButton } from "./actions";

export const metadata: Metadata = { title: "Payment" };

export default async function PaymentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ recorded?: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("payments.read");
  if (!allowed) return <Forbidden what="payments" />;
  let p;
  try {
    p = await getPayment(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const sp = await searchParams;
  const tz = ctx.organization.timezone;
  const m = (v: { toString(): string }) => formatMoney(v.toString(), p.currency);
  const openInvoices = p.subscriberId
    ? await db.invoice.findMany({ where: { organizationId: ctx.organizationId, subscriberId: p.subscriberId, status: { in: ["OPEN", "PARTIALLY_PAID"] }, currency: p.currency }, orderBy: { dueAt: "asc" }, select: { id: true, invoiceNumber: true, balanceDue: true } })
    : [];

  return (
    <div className="space-y-6">
      {sp.recorded ? <Alert tone="success" title={`Payment recorded · receipt ${p.receiptNumber}`} /> : null}
      <PageHeader
        title={`Receipt ${p.receiptNumber ?? ""}`}
        description={`${METHOD_LABEL[p.method]} · ${p.provider === "manual" ? `recorded by ${p.recordedBy ?? "staff"}` : p.provider}`}
        actions={
          <a href={`/api/v1/payments/${p.id}/receipt`} target="_blank" rel="noopener" className={buttonVariants({ variant: "secondary" })}>
            <Download /> Receipt PDF
          </a>
        }
      />
      {p.status === "REVERSED" ? (
        <Alert tone="danger" title="This payment was reversed">
          {p.reversalReason} · {formatDateTime(p.reversedAt, tz)}
        </Alert>
      ) : null}
      {!p.subscriberId && p.status === "CONFIRMED" ? <Alert tone="warning" title="Unmatched payment">This receipt is not yet linked to a subscriber. Match it below to apply it to their invoices.</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Summary</CardTitle>
            <PaymentStatusBadge status={p.status} />
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Amount">
              <span className="tabular text-base font-semibold">{m(p.amount)}</span>
            </Row>
            <Row label="Allocated">{m(p.allocatedAmount)}</Row>
            <Row label="Refunded">{m(p.refundedAmount)}</Row>
            <Row label="Unallocated (credit)">{m(p.unallocated)}</Row>
            <Row label="Received">{formatDateTime(p.receivedAt, tz)}</Row>
            {p.providerTransactionId ? <Row label="Reference">{p.providerTransactionId}</Row> : null}
            {p.payerName ? <Row label="Payer">{p.payerName}</Row> : null}
            <Row label="Subscriber">
              {p.subscriber ? (
                <Link href={`/subscribers/${p.subscriber.id}`} className="text-accent hover:underline">
                  {p.subscriber.displayName}
                </Link>
              ) : (
                "Unmatched"
              )}
            </Row>
            {p.notes ? <p className="rounded-md bg-surface-muted p-2 text-xs">{p.notes}</p> : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Allocations</CardTitle>
          </CardHeader>
          {p.allocations.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">Not applied to any invoice.</CardContent>
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Applied</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {p.allocations.map((a) => (
                  <Tr key={a.id}>
                    <Td label="Invoice">
                      <Link href={`/invoices/${a.invoice.id}`} className="font-mono text-xs text-accent hover:underline">
                        {a.invoice.invoiceNumber}
                      </Link>
                    </Td>
                    <Td label="Applied">{formatDateTime(a.createdAt, tz)}</Td>
                    <Td label="Status">{a.status === "ACTIVE" ? "Applied" : `Reversed: ${a.reversalReason ?? ""}`}</Td>
                    <Td label="Amount" className={`tabular md:text-right ${a.status === "REVERSED" ? "text-muted-foreground line-through" : ""}`}>
                      {m(a.amount)}
                    </Td>
                    <Td label="Actions" className="md:text-right">
                      {a.status === "ACTIVE" && ctx.permissions.has("payments.reconcile") ? <ReverseAllocationButton paymentId={p.id} allocationId={a.id} label={`${a.invoice.invoiceNumber} · ${m(a.amount)}`} /> : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
          {p.refunds.length ? (
            <CardContent className="border-t border-border text-sm">
              <p className="mb-2 font-medium">Refunds</p>
              <ul className="space-y-1">
                {p.refunds.map((r) => (
                  <li key={r.id} className="flex justify-between gap-4">
                    <span>
                      {formatDateTime(r.refundedAt, tz)} · {METHOD_LABEL[r.method]} · {r.reason}
                    </span>
                    <span className="tabular">{m(r.amount)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          ) : null}
        </Card>
      </div>

      {p.status === "CONFIRMED" ? (
        <PaymentActions
          payment={{ id: p.id, currency: p.currency, unallocated: p.unallocated, matched: Boolean(p.subscriberId), refunded: Number(p.refundedAmount.toString()) > 0, receipt: p.receiptNumber ?? "" }}
          openInvoices={openInvoices.map((i) => ({ id: i.id, label: `${i.invoiceNumber} — balance ${formatMoney(i.balanceDue.toString(), p.currency)}`, balance: i.balanceDue.toString() }))}
          can={{ allocate: ctx.permissions.has("payments.allocate"), refund: ctx.permissions.has("payments.refund"), reconcile: ctx.permissions.has("payments.reconcile") }}
        />
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
