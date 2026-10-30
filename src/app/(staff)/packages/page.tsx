import type { Metadata } from "next";
import Link from "next/link";
import { Package as PackageIcon, Plus, Zap } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { catalogueQuery, packageCatalogue } from "@/server/services/packages";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader, type Tone } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { StatStrip } from "@/components/stat-strip";
import { Forbidden } from "@/components/shell/forbidden";
import { formatMoney } from "@/lib/utils";
import { AVAILABILITY_LABEL, HIGHLIGHT_LABEL, PLAN_TYPE_LABEL, describeSchedule, durationShort, formatRatePair, hasBurst, quotaLabel, type Availability, type PlanType } from "@/lib/plans";
import { PlanRowActions } from "./row-actions";

export const metadata: Metadata = { title: "Plans" };

const AVAILABILITY_TONE: Record<Availability, Tone> = { LIVE: "success", HIDDEN: "neutral", OFF: "warning", ARCHIVED: "neutral" };
const TYPE_TONE: Record<PlanType, Tone> = { HOTSPOT: "info", PPPOE: "success", DATA: "warning", TRIAL: "neutral", DEVICE: "neutral", STATIC_IP: "neutral", OTHER: "neutral" };
const TAB_ORDER: PlanType[] = ["HOTSPOT", "PPPOE", "DATA", "TRIAL", "DEVICE", "STATIC_IP", "OTHER"];

export default async function PackagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("packages.read");
  if (!allowed) return <Forbidden what="plans" />;
  const sp = await searchParams;
  const parsed = catalogueQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : catalogueQuery.parse({});
  const { rows, stats, typeCounts } = await packageCatalogue(ctx, query);
  const canWrite = ctx.permissions.has("packages.write");
  const canSync = ctx.permissions.has("network.operate");
  const current = { q: sp.q, type: sp.type, view: sp.view };
  const archived = query.view === "archived";

  return (
    <div className="space-y-6">
      <PageHeader
        title={archived ? "Archived plans" : "Internet plans"}
        description={archived ? "Plans no longer sold. Existing records keep referring to them." : `Every plan you offer, by type. ${stats.live} live for customers.`}
        actions={
          canWrite && !archived ? (
            <Link href="/packages/new" className={buttonVariants()}>
              <Plus /> New plan
            </Link>
          ) : null
        }
      />
      {!archived ? (
        <StatStrip
          stats={[
            { label: "All plans", value: stats.all, hint: `${stats.plansWithSubscribers} with subscribers` },
            { label: "Live", value: stats.live, hint: "Customers can buy", tone: "success" },
            { label: "Hidden", value: stats.hidden, hint: "Staff can assign" },
            { label: "Off", value: stats.off, hint: "Not sold" },
            { label: "Subscribers", value: stats.subscribers, hint: "On live subscriptions" },
          ]}
        />
      ) : null}
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Plan type"
            active={query.type}
            items={[
              { value: "ALL", label: "All", count: stats.all, href: buildHref("/packages", current, { type: undefined }) },
              ...TAB_ORDER.filter((t) => typeCounts[t] > 0).map((t) => ({ value: t, label: PLAN_TYPE_LABEL[t], count: typeCounts[t], href: buildHref("/packages", current, { type: t }) })),
            ]}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link href={buildHref("/packages", current, { view: archived ? undefined : "archived", type: undefined })} className="whitespace-nowrap text-sm text-accent hover:underline">
              {archived ? "Back to current plans" : "Archived plans"}
            </Link>
            <SearchForm action="/packages" q={sp.q} placeholder="Search plans" hidden={{ type: sp.type, view: sp.view }} />
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title={sp.q || query.type !== "ALL" ? "No plans match" : archived ? "No archived plans" : "No plans yet"}
            description={canWrite && !archived ? "Create the plans you sell: hotspot time plans, data bundles and monthly PPPoE plans." : undefined}
            action={
              canWrite && !sp.q && !archived ? (
                <Link href="/packages/new" className={buttonVariants()}>
                  <Plus /> New plan
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Plan</Th>
                <Th>Type</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Subscribers</Th>
                <Th className="text-right">Revenue 30d</Th>
                <Th>Status</Th>
                <Th className="w-12">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((p) => {
                const schedule = describeSchedule(p);
                const speed = formatRatePair(p.uploadKbps, p.downloadKbps);
                return (
                  <Tr key={p.id} className={p.availability === "OFF" ? "text-muted-foreground" : undefined}>
                    <Td label="Plan">
                      <div className="min-w-0 text-right md:text-left">
                        <Link href={`/packages/${p.id}`} className="font-medium text-foreground hover:underline">
                          {p.name}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-xs text-muted-foreground md:justify-start">
                          {speed ? <span className="font-mono">{speed}</span> : <span>No speed limit</span>}
                          <span aria-hidden>·</span>
                          <span>{durationShort(p.billingUnit, p.billingCount)}</span>
                          {p.dataQuotaMb ? (
                            <>
                              <span aria-hidden>·</span>
                              <span>{quotaLabel(p.dataQuotaMb)}</span>
                            </>
                          ) : null}
                          {p.deviceLimit && p.deviceLimit > 1 ? <span className="rounded border border-border px-1">{p.deviceLimit} devices</span> : null}
                          {hasBurst(p) ? (
                            <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1 text-accent">
                              <Zap className="size-3" aria-hidden /> Burst
                            </span>
                          ) : null}
                          {schedule ? <span className="rounded border border-border px-1">{schedule}</span> : null}
                          {p.routerIds.length ? <span className="rounded border border-border px-1">{p.routerIds.length} router{p.routerIds.length === 1 ? "" : "s"} only</span> : null}
                        </p>
                      </div>
                    </Td>
                    <Td label="Type">
                      <Badge tone={TYPE_TONE[p.planType]}>{PLAN_TYPE_LABEL[p.planType]}</Badge>
                    </Td>
                    <Td label="Price" className="tabular whitespace-nowrap md:text-right">
                      {Number(p.price) === 0 ? "Free" : formatMoney(p.price.toString(), p.currency)}
                    </Td>
                    <Td label="Subscribers" className="tabular md:text-right">
                      {p.activeSubscriptions || "—"}
                    </Td>
                    <Td label="Revenue 30d" className="tabular whitespace-nowrap md:text-right">
                      {p.revenue30d === null ? <span className="text-xs text-muted-foreground">No access</span> : Number(p.revenue30d) > 0 ? formatMoney(p.revenue30d, p.currency) : "—"}
                    </Td>
                    <Td label="Status">
                      <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                        <Badge tone={AVAILABILITY_TONE[p.availability]}>{AVAILABILITY_LABEL[p.availability]}</Badge>
                        {p.highlight ? <Badge tone="info">{HIGHLIGHT_LABEL[p.highlight] ?? p.highlight}</Badge> : null}
                      </span>
                    </Td>
                    <Td label="Actions" className="md:text-right">
                      <PlanRowActions id={p.id} name={p.name} availability={p.availability} canWrite={canWrite} canSync={canSync && Boolean(speed) && (p.serviceType === "PPPOE" || p.serviceType === "HOTSPOT")} />
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
