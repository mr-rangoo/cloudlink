import type { Metadata } from "next";
import { getCustomerContext } from "@/server/portal/page";
import { listCustomerPayments } from "@/server/portal/services";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { METHOD_LABEL, PaymentStatusBadge } from "@/components/status";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Payments · Customer portal" };

export default async function PortalPayments() {
  const ctx = await getCustomerContext();
  const payments = await listCustomerPayments(ctx);
  const tz = ctx.organization.timezone;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Payments</h1>
      <p className="text-sm text-muted-foreground">Payments appear here only after {ctx.organization.name} confirms them.</p>
      <Card>
        {payments.length === 0 ? (
          <EmptyState title="No payments yet" />
        ) : (
          <ul className="divide-y divide-border">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block font-mono text-sm">{p.receiptNumber ?? "Pending"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {METHOD_LABEL[p.method]}
                    {p.reference ? ` · ${p.reference}` : ""} · {formatDateTime(p.receivedAt, tz)}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span className="tabular text-sm font-medium">{formatMoney(p.amount.toString(), p.currency)}</span>
                  <PaymentStatusBadge status={p.status} />
                  {p.status !== "PENDING" ? (
                    <a href={`/api/v1/customer/receipts/${p.id}`} target="_blank" rel="noopener" className="text-xs text-accent hover:underline">
                      Receipt
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
