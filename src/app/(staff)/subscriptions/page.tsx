import type { Metadata } from "next";
import Link from "next/link";
import { Repeat } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listSubscriptions, subscriptionListQuery } from "@/server/services/subscriptions";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { SubscriptionStatusBadge, formatInterval } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Subscriptions" };

export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("subscriptions.read");
  if (!allowed) return <Forbidden what="subscriptions" />;
  const sp = await searchParams;
  const parsed = subscriptionListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : subscriptionListQuery.parse({});
  const { rows, total } = await listSubscriptions(ctx, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = { q: sp.q, status: sp.status, expiring: sp.expiring };
  const tz = ctx.organization.timezone;
  const tab = query.expiring === "24h" ? "EXPIRING24" : query.expiring ? "EXPIRING" : query.status;
  const href = (patch: Record<string, string | undefined>) => buildHref("/subscriptions", current, { ...patch, page: undefined });

  return (
    <div className="space-y-6">
      <PageHeader title="All subscriptions" description="Billing status of every subscription. Manage a subscription from its subscriber page." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Subscription status"
            active={tab}
            items={[
              { value: "ALL", label: "All", href: href({ status: undefined, expiring: undefined }) },
              { value: "ACTIVE", label: "Active", href: href({ status: "ACTIVE", expiring: undefined }) },
              { value: "EXPIRING24", label: "Expiring in 24 hours", href: href({ status: undefined, expiring: "24h" }) },
              { value: "EXPIRING", label: "Expiring in 7 days", href: href({ status: undefined, expiring: "7d" }) },
              { value: "PENDING", label: "Pending", href: href({ status: "PENDING", expiring: undefined }) },
              { value: "SUSPENDED", label: "Suspended", href: href({ status: "SUSPENDED", expiring: undefined }) },
              { value: "EXPIRED", label: "Expired", href: href({ status: "EXPIRED", expiring: undefined }) },
              { value: "CANCELLED", label: "Cancelled", href: href({ status: "CANCELLED", expiring: undefined }) },
            ]}
          />
          <SearchForm action="/subscriptions" q={sp.q} placeholder="Subscriber, account or package" hidden={{ status: sp.status, expiring: sp.expiring }} />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={Repeat} title="No subscriptions match" description="Subscriptions are created from a subscriber's page or when converting a lead." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Subscriber</Th>
                  <Th>Package</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Price</Th>
                  <Th>Current period</Th>
                  <Th>Next billing</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((s) => (
                  <Tr key={s.id}>
                    <Td label="Subscriber">
                      <Link href={`/subscribers/${s.subscriber.id}`} className="font-medium hover:underline">
                        {s.subscriber.displayName}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{s.subscriber.accountNumber}</span>
                    </Td>
                    <Td label="Package">{s.packageName}</Td>
                    <Td label="Status">
                      <SubscriptionStatusBadge status={s.status} />
                    </Td>
                    <Td label="Price" className="tabular whitespace-nowrap md:text-right">
                      {formatMoney(s.price.toString(), s.currency)} <span className="text-xs text-muted-foreground">{formatInterval(s.billingUnit, s.billingCount)}</span>
                    </Td>
                    <Td label="Current period" className="whitespace-nowrap">
                      {s.currentPeriodStart && s.currentPeriodEnd ? `${formatDate(s.currentPeriodStart, tz)} → ${formatDate(s.currentPeriodEnd, tz)}` : "—"}
                    </Td>
                    <Td label="Next billing" className="whitespace-nowrap">
                      {s.nextBillingAt ? formatDate(s.nextBillingAt, tz) : "—"}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/subscriptions", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
