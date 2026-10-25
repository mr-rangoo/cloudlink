import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Upload, Users } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listSubscribers, subscriberListQuery } from "@/server/services/subscribers";
import { formatPhone } from "@/server/domain/contact";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { SubscriptionStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Subscribers" };

export default async function SubscribersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("subscribers.read");
  if (!allowed) return <Forbidden what="subscribers" />;
  const sp = await searchParams;
  const parsed = subscriberListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : subscriberListQuery.parse({});
  const { rows, total } = await listSubscribers(ctx, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = { q: sp.q, subscription: sp.subscription, sort: sp.sort, status: sp.status };
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscribers"
        description="Customer accounts, contacts and their subscriptions."
        actions={
          <>
            {ctx.permissions.has("subscribers.import") ? (
              <Link href="/subscribers/import" className={buttonVariants({ variant: "secondary" })}>
                <Upload /> Import CSV
              </Link>
            ) : null}
            {ctx.permissions.has("subscribers.write") ? (
              <Link href="/subscribers/new" className={buttonVariants()}>
                <Plus /> New subscriber
              </Link>
            ) : null}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Subscription filter"
            active={query.subscription ?? "ALL"}
            items={[
              { value: "ALL", label: "All", href: buildHref("/subscribers", current, { subscription: undefined, page: undefined }) },
              { value: "ACTIVE", label: "Active", href: buildHref("/subscribers", current, { subscription: "ACTIVE", page: undefined }) },
              { value: "SUSPENDED", label: "Suspended", href: buildHref("/subscribers", current, { subscription: "SUSPENDED", page: undefined }) },
              { value: "EXPIRED", label: "Expired", href: buildHref("/subscribers", current, { subscription: "EXPIRED", page: undefined }) },
              { value: "NONE", label: "No live plan", href: buildHref("/subscribers", current, { subscription: "NONE", page: undefined }) },
            ]}
          />
          <SearchForm action="/subscribers" q={sp.q} placeholder="Name, account no., phone, email" hidden={{ subscription: sp.subscription, sort: sp.sort }} />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={sp.q || sp.subscription ? "No subscribers match these filters" : "No subscribers yet"}
            description={sp.q || sp.subscription ? "Try a different search or filter." : "Create a subscriber, convert a lead, or import a CSV to get started."}
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Account</Th>
                  <Th>Subscriber</Th>
                  <Th>Phone</Th>
                  <Th>Subscription</Th>
                  <Th>Paid until</Th>
                  <Th>Created</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((s) => {
                  const live = s.subscriptions[0];
                  return (
                    <Tr key={s.id}>
                      <Td label="Account" className="font-mono text-xs">
                        <Link href={`/subscribers/${s.id}`} className="text-accent hover:underline">
                          {s.accountNumber}
                        </Link>
                      </Td>
                      <Td label="Subscriber">
                        <div className="text-right md:text-left">
                          <Link href={`/subscribers/${s.id}`} className="font-medium hover:underline">
                            {s.displayName}
                          </Link>
                          {s.email ? <p className="text-xs text-muted-foreground">{s.email}</p> : null}
                        </div>
                      </Td>
                      <Td label="Phone" className="tabular whitespace-nowrap">
                        {formatPhone(s.phone)}
                      </Td>
                      <Td label="Subscription">
                        {live ? (
                          <span className="flex items-center gap-2">
                            <SubscriptionStatusBadge status={live.status} />
                            <span className="text-xs text-muted-foreground">{live.packageName}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                      </Td>
                      <Td label="Paid until" className="whitespace-nowrap">
                        {live?.currentPeriodEnd ? formatDate(live.currentPeriodEnd, tz) : "—"}
                      </Td>
                      <Td label="Created" className="whitespace-nowrap text-muted-foreground">
                        {formatDate(s.createdAt, tz)}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/subscribers", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
