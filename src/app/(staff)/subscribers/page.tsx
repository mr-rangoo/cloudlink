import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Star, Upload, Users } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listSubscribers, subscriberListQuery, subscriberStats } from "@/server/services/subscribers";
import { routerNameOptions } from "@/server/services/routers";
import { formatPhone } from "@/server/domain/contact";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { StatStrip } from "@/components/stat-strip";
import { SubscriptionStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Subscribers" };

const SERVICE: Record<string, string> = { PPPOE: "PPPoE", HOTSPOT: "Hotspot", STATIC_IP: "Static IP", OTHER: "Other" };
const FILTER_KEYS = ["q", "subscription", "sort", "status", "service", "connection", "routerId", "created", "vip", "risk"] as const;

/** "3 h ago", "2 d ago": server-rendered, so it is as fresh as the page. */
function ago(at: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export default async function SubscribersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("subscribers.read");
  if (!allowed) return <Forbidden what="subscribers" />;
  // The filter form submits "Any" as an empty value: drop those so they do not invalidate the rest.
  const sp = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => v)) as Record<string, string | undefined>;
  const parsed = subscriberListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : subscriberListQuery.parse({});
  const [{ rows, total }, stats, routers] = await Promise.all([listSubscribers(ctx, query), subscriberStats(ctx), ctx.permissions.has("routers.read") ? routerNameOptions(ctx) : Promise.resolve([])]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp[k]]));
  const href = (patch: Record<string, string | undefined>) => buildHref("/subscribers", current, { ...patch, page: undefined });
  const tz = ctx.organization.timezone;
  const now = new Date();
  const filtered = FILTER_KEYS.some((k) => k !== "sort" && sp[k]);
  const advanced = Boolean(sp.service || sp.connection || sp.routerId || sp.created || sp.vip || sp.risk);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your subscribers"
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
      <StatStrip
        stats={[
          { label: "Subscribers", value: stats.total, hint: `${stats.newLast30Days} new in 30 days`, href: href({ created: "30d" }) },
          { label: "With an active plan", value: stats.active, href: href({ subscription: "ACTIVE" }) },
          { label: "Online now", value: stats.online, tone: "success", href: href({ connection: "online" }) },
          { label: "Active but offline", value: stats.offline, href: href({ connection: "offline" }) },
          { label: "At risk", value: stats.atRisk, hint: "Ending soon or just expired", tone: stats.atRisk ? "danger" : "default", href: href({ risk: "1" }) },
          { label: "VIP", value: stats.vip, href: href({ vip: "1" }) },
        ]}
      />
      <Card>
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <FilterTabs
              label="Subscription filter"
              active={query.subscription ?? "ALL"}
              items={[
                { value: "ALL", label: "All", href: href({ subscription: undefined }) },
                { value: "ACTIVE", label: "Active", href: href({ subscription: "ACTIVE" }) },
                { value: "SUSPENDED", label: "Suspended", href: href({ subscription: "SUSPENDED" }) },
                { value: "EXPIRED", label: "Expired", href: href({ subscription: "EXPIRED" }) },
                { value: "NONE", label: "No live plan", href: href({ subscription: "NONE" }) },
              ]}
            />
            <SearchForm action="/subscribers" q={sp.q} placeholder="Name, account no., phone, email" hidden={{ ...current, q: undefined }} />
          </div>
          <form action="/subscribers" className="flex flex-wrap items-end gap-2" aria-label="More filters">
            {(["q", "subscription", "sort"] as const).map((k) => (sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null))}
            <FilterSelect name="service" label="Service" value={sp.service} options={Object.entries(SERVICE).map(([value, label]) => ({ value, label }))} />
            <FilterSelect
              name="connection"
              label="Connection"
              value={sp.connection}
              options={[
                { value: "online", label: "Online now" },
                { value: "offline", label: "Active but offline" },
              ]}
            />
            {routers.length ? <FilterSelect name="routerId" label="Router" value={sp.routerId} options={routers.map((r) => ({ value: r.id, label: r.name }))} /> : null}
            <FilterSelect
              name="created"
              label="Joined"
              value={sp.created}
              options={[
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
                { value: "90d", label: "Last 90 days" },
              ]}
            />
            <label className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm">
              <input type="checkbox" name="vip" value="1" defaultChecked={Boolean(sp.vip)} /> VIP
            </label>
            <label className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm">
              <input type="checkbox" name="risk" value="1" defaultChecked={Boolean(sp.risk)} /> At risk
            </label>
            <Button type="submit" variant="secondary" size="sm" className="h-9">
              Apply
            </Button>
            {advanced ? (
              <Link href={buildHref("/subscribers", { q: sp.q, subscription: sp.subscription, sort: sp.sort }, {})} className="h-9 px-2 text-sm leading-9 text-accent hover:underline">
                Clear filters
              </Link>
            ) : null}
          </form>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={filtered ? "No subscribers match these filters" : "No subscribers yet"}
            description={filtered ? "Try a different search or filter." : "Create a subscriber, convert a lead, or import a CSV to get started."}
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Account</Th>
                  <Th>Subscriber</Th>
                  <Th>Phone</Th>
                  <Th>Plan</Th>
                  <Th>Router</Th>
                  <Th>Connection</Th>
                  <Th>Paid until</Th>
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
                          <span className="inline-flex items-center gap-1.5">
                            <Link href={`/subscribers/${s.id}`} className="font-medium hover:underline">
                              {s.displayName}
                            </Link>
                            {s.vip ? (
                              <Badge tone="warning" className="gap-0.5">
                                <Star className="size-3" aria-hidden /> VIP
                              </Badge>
                            ) : null}
                          </span>
                          <p className="text-xs text-muted-foreground">Joined {formatDate(s.createdAt, tz)}</p>
                        </div>
                      </Td>
                      <Td label="Phone" className="tabular whitespace-nowrap">
                        {formatPhone(s.phone)}
                      </Td>
                      <Td label="Plan">
                        {live ? (
                          <div className="text-right md:text-left">
                            <SubscriptionStatusBadge status={live.status} />
                            <p className="text-xs text-muted-foreground">
                              {live.packageName} · {SERVICE[live.serviceType] ?? live.serviceType}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                      </Td>
                      <Td label="Router" className="text-sm">
                        {s.router ? s.router.name : <span className="text-muted-foreground">—</span>}
                      </Td>
                      <Td label="Connection" className="whitespace-nowrap">
                        {s.online ? (
                          <Badge tone="success">Online</Badge>
                        ) : s.lastSeenAt ? (
                          <span className="text-xs text-muted-foreground" title={formatDateTime(s.lastSeenAt, tz)}>
                            Last seen {ago(s.lastSeenAt, now)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Never seen</span>
                        )}
                      </Td>
                      <Td label="Paid until" className="whitespace-nowrap">
                        {live?.currentPeriodEnd ? formatDateTime(live.currentPeriodEnd, tz) : "—"}
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

function FilterSelect({ name, label, value, options }: { name: string; label: string; value?: string; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Select name={name} defaultValue={value ?? ""} className="h-9 min-w-36">
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
