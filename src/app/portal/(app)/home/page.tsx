import type { Metadata } from "next";
import Link from "next/link";
import { getCustomerContext } from "@/server/portal/page";
import { customerOverview } from "@/server/portal/services";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { METHOD_LABEL, SubscriptionStatusBadge, formatInterval } from "@/components/status";
import { formatDate, formatMoney } from "@/lib/utils";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { PortalPayForm } from "../pay-form";
import { brandingFor } from "@/server/services/branding";
import { activePaymentInstructions } from "@/server/services/payment-methods";
import { PaymentMethodsList } from "../payment-methods";

export const metadata: Metadata = { title: "My account · Customer portal" };

export default async function PortalHome() {
  const ctx = await getCustomerContext();
  const o = await customerOverview(ctx);
  const cur = ctx.organization.currency;
  const tz = ctx.organization.timezone;
  const net = Number(o.balance.net);
  const [{ portalWelcome: welcome }, methods] = await Promise.all([brandingFor(ctx.organizationId), activePaymentInstructions(ctx.organizationId, o.subscriber.accountNumber)]);
  const paymentMode = paymentAdapterMode();
  const payOnline = paymentMode !== "disabled" && cur === "KES";

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Hello, {o.subscriber.displayName.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground">Account number {o.subscriber.accountNumber}</p>
        {welcome ? <p className="pt-1 text-sm">{welcome}</p> : null}
      </div>

      <Card className={net > 0 ? "border-danger/30" : undefined}>
        <CardContent className="space-y-3 py-5">
          <p className="text-sm text-muted-foreground">{net > 0 ? "Amount due" : net < 0 ? "Account credit" : "Balance"}</p>
          <p className={`tabular text-3xl font-semibold ${net > 0 ? "text-danger" : "text-success"}`}>{formatMoney(Math.abs(net).toFixed(2), cur)}</p>
          {net > 0 ? (
            <div className="space-y-2 rounded-md bg-surface-muted p-3 text-sm">
              <p className="font-medium">{payOnline ? "Other ways to pay" : "How to pay"}</p>
              <PaymentMethodsList methods={methods} accountNumber={o.subscriber.accountNumber} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">You are all paid up. Thank you!</p>
          )}
        </CardContent>
      </Card>

      {payOnline ? (
        // Kept in a fixed position so the payment result stays on screen when the balance above refreshes.
        <Card>
          <CardHeader>
            <CardTitle>Pay with M-Pesa</CardTitle>
          </CardHeader>
          <CardContent>
            <PortalPayForm phone={o.subscriber.phone} amount={net > 0 ? Math.ceil(net) : 0} simulated={paymentMode === "mock"} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>My service</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {o.subscriptions.length === 0 ? <p className="text-sm text-muted-foreground">No active service.</p> : null}
          {o.subscriptions.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <p className="font-medium">{s.packageName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatMoney(s.price.toString(), s.currency)} {formatInterval(s.billingUnit, s.billingCount)}
                  {s.currentPeriodEnd ? ` · paid until ${formatDate(s.currentPeriodEnd, tz)}` : ""}
                </p>
              </div>
              <SubscriptionStatusBadge status={s.status} />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Open invoices</CardTitle>
            <Link href="/portal/invoices" className="text-xs text-accent hover:underline">
              All invoices
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {o.openInvoices.length === 0 ? <p className="text-muted-foreground">None.</p> : null}
            {o.openInvoices.map((i) => (
              <Link key={i.id} href={`/portal/invoices/${i.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-muted">
                <span>
                  <span className="font-mono text-xs">{i.invoiceNumber}</span>
                  <span className="block text-xs text-muted-foreground">Due {formatDate(i.dueAt, tz)}</span>
                </span>
                <span className="tabular font-medium">{formatMoney(i.balanceDue.toString(), i.currency)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent payments</CardTitle>
            <Link href="/portal/payments" className="text-xs text-accent hover:underline">
              All payments
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {o.recentPayments.length === 0 ? <p className="text-muted-foreground">None yet.</p> : null}
            {o.recentPayments.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-2 py-1.5">
                <span>
                  <span className="font-mono text-xs">{p.receiptNumber}</span>
                  <span className="block text-xs text-muted-foreground">
                    {METHOD_LABEL[p.method]} · {formatDate(p.receivedAt, tz)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="tabular font-medium">{formatMoney(p.amount.toString(), p.currency)}</span>
                  {p.status === "REVERSED" ? <Badge tone="danger">Reversed</Badge> : null}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
