import Link from "next/link";
import { FileText, Wallet } from "lucide-react";
import { db } from "@/server/db/client";
import type { StaffContext } from "@/server/auth/context";
import { subscriberLedgerBalance } from "@/server/services/ledger";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { InvoiceStatusBadge, METHOD_LABEL, PaymentStatusBadge } from "@/components/status";
import { formatDate, formatMoney } from "@/lib/utils";

/** Server component: subscriber balance from the ledger plus recent invoices and payments. */
export async function BillingCard({ ctx, subscriberId }: { ctx: StaffContext; subscriberId: string }) {
  const canInv = ctx.permissions.has("invoices.read");
  const canPay = ctx.permissions.has("payments.read");
  const now = new Date();
  const [balance, invoices, payments] = await Promise.all([
    subscriberLedgerBalance(db, ctx.organizationId, subscriberId),
    canInv ? db.invoice.findMany({ where: { organizationId: ctx.organizationId, subscriberId }, orderBy: { createdAt: "desc" }, take: 6 }) : Promise.resolve([]),
    canPay ? db.payment.findMany({ where: { organizationId: ctx.organizationId, subscriberId }, orderBy: { createdAt: "desc" }, take: 6 }) : Promise.resolve([]),
  ]);
  const cur = ctx.organization.currency;
  const tz = ctx.organization.timezone;
  const owes = balance.net.gt(0);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Billing</CardTitle>
          <CardDescription>Balance from the ledger: receivables minus account credit</CardDescription>
        </div>
        <div className="flex gap-2">
          {ctx.permissions.has("invoices.write") ? (
            <Link href={`/invoices/new?subscriberId=${subscriberId}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <FileText /> New invoice
            </Link>
          ) : null}
          {ctx.permissions.has("payments.record") ? (
            <Link href={`/payments/new?subscriberId=${subscriberId}`} className={buttonVariants({ size: "sm" })}>
              <Wallet /> Record payment
            </Link>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure label="Owed (open invoices)" value={formatMoney(balance.receivable.toFixed(2), cur)} />
          <Figure label="Account credit" value={formatMoney(balance.credit.toFixed(2), cur)} />
          <Figure label={owes ? "Net balance due" : "Net balance"} value={formatMoney(balance.net.abs().toFixed(2), cur)} tone={owes ? "danger" : "success"} suffix={owes ? "due" : balance.net.lt(0) ? "in credit" : "settled"} />
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {canInv ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">Recent invoices</h3>
              {invoices.length ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {invoices.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <Link href={`/invoices/${i.id}`} className="font-mono text-xs text-accent hover:underline">
                        {i.invoiceNumber ?? "Draft"}
                      </Link>
                      <span className="text-xs text-muted-foreground">{formatDate(i.issuedAt ?? i.createdAt, tz)}</span>
                      <InvoiceStatusBadge status={i.status} overdue={(i.status === "OPEN" || i.status === "PARTIALLY_PAID") && !!i.dueAt && i.dueAt < now} />
                      <span className="tabular">{formatMoney(i.total.toString(), i.currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No invoices.</p>
              )}
            </div>
          ) : null}
          {canPay ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">Recent payments</h3>
              {payments.length ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <Link href={`/payments/${p.id}`} className="font-mono text-xs text-accent hover:underline">
                        {p.receiptNumber ?? "—"}
                      </Link>
                      <span className="text-xs text-muted-foreground">{METHOD_LABEL[p.method]}</span>
                      <PaymentStatusBadge status={p.status} />
                      <span className="tabular">{formatMoney(p.amount.toString(), p.currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No payments.</p>
              )}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, tone, suffix }: { label: string; value: string; tone?: "danger" | "success"; suffix?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/50 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`tabular text-lg font-semibold ${tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : ""}`}>
        {value} {suffix ? <span className="text-xs font-normal text-muted-foreground">{suffix}</span> : null}
      </p>
    </div>
  );
}
