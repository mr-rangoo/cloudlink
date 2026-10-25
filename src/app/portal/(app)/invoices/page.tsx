import type { Metadata } from "next";
import Link from "next/link";
import { getCustomerContext } from "@/server/portal/page";
import { listCustomerInvoices } from "@/server/portal/services";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { InvoiceStatusBadge } from "@/components/status";
import { formatDate, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Invoices · Customer portal" };

export default async function PortalInvoices() {
  const ctx = await getCustomerContext();
  const invoices = await listCustomerInvoices(ctx);
  const tz = ctx.organization.timezone;
  const now = new Date();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Invoices</h1>
      <Card>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <ul className="divide-y divide-border">
            {invoices.map((i) => (
              <li key={i.id}>
                <Link href={`/portal/invoices/${i.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted/50">
                  <span className="min-w-0">
                    <span className="block font-mono text-sm">{i.invoiceNumber}</span>
                    <span className="block text-xs text-muted-foreground">
                      Issued {formatDate(i.issuedAt, tz)} · due {formatDate(i.dueAt, tz)}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="tabular text-sm font-medium">{formatMoney(i.total.toString(), i.currency)}</span>
                    <InvoiceStatusBadge status={i.status} overdue={(i.status === "OPEN" || i.status === "PARTIALLY_PAID") && !!i.dueAt && i.dueAt < now} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
