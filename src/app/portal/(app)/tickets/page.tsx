import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { getCustomerContext } from "@/server/portal/page";
import { listCustomerTickets } from "@/server/services/tickets";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState } from "@/components/ui/feedback";
import { buttonVariants } from "@/components/ui/button";
import { TICKET_TONE, humanize } from "@/components/status";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Support · Customer portal" };

export default async function PortalTickets() {
  const ctx = await getCustomerContext();
  const tickets = await listCustomerTickets(ctx);
  const tz = ctx.organization.timezone;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Support</h1>
        <Link href="/portal/tickets/new" className={buttonVariants()}>
          <Plus /> New request
        </Link>
      </div>
      <Card>
        {tickets.length === 0 ? (
          <EmptyState title="No support requests" description="Having trouble with your connection or bill? Open a request and our team will respond." />
        ) : (
          <ul className="divide-y divide-border">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link href={`/portal/tickets/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted/50">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{t.subject}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t.ticketNumber} · updated {formatDateTime(t.updatedAt, tz)}
                    </span>
                  </span>
                  <Badge tone={TICKET_TONE[t.status]}>{humanize(t.status)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
