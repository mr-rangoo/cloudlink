import type { Metadata } from "next";
import Link from "next/link";
import { Router as RouterIcon } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listRouters, routerListQuery } from "@/server/services/routers";
import { listAccessibleBranches } from "@/server/auth/service";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { RouterStatusBadge } from "@/components/status";
import { StatStrip } from "@/components/stat-strip";
import { AdapterNotice, formatDuration } from "@/components/network-notice";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { RouterFormDialog } from "./client";

export const metadata: Metadata = { title: "Routers" };

export default async function RoutersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("routers.read");
  if (!allowed) return <Forbidden what="routers" />;
  const sp = await searchParams;
  const parsed = routerListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : routerListQuery.parse({});
  const { rows, total, adapter, summary } = await listRouters(ctx, query);
  const canWrite = ctx.permissions.has("routers.write");
  const branches = canWrite ? await listAccessibleBranches(ctx) : [];
  const tz = ctx.organization.timezone;
  const current = { q: sp.q, status: sp.status, archived: sp.archived };
  const href = (patch: Record<string, string | undefined>) => buildHref("/routers", current, { ...patch, page: undefined });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Routers"
        description="MikroTik routers reached over private or VPN addresses. API credentials are encrypted and never shown again."
        actions={canWrite ? <RouterFormDialog branches={branches.map((b) => ({ id: b.id, name: b.name }))} /> : null}
      />
      <AdapterNotice adapter={adapter} />
      <StatStrip
        stats={[
          { label: "Routers", value: summary.total, hint: summary.maintenance ? `${summary.maintenance} in maintenance` : "Not archived" },
          { label: "Online", value: summary.online, tone: summary.online ? "success" : "default", href: href({ status: "ONLINE", archived: undefined }) },
          { label: "Offline", value: summary.offline, tone: summary.offline ? "danger" : "default", href: href({ status: "OFFLINE", archived: undefined }) },
          { label: adapter === "mock" ? "Simulated" : "Not checked", value: summary.unknown, href: href({ status: "UNKNOWN", archived: undefined }) },
        ]}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Router status"
            active={query.archived === "true" ? "ARCHIVED" : query.status}
            items={[
              { value: "ALL", label: "All", href: href({ status: undefined, archived: undefined }) },
              { value: "ONLINE", label: "Online", href: href({ status: "ONLINE", archived: undefined }) },
              { value: "OFFLINE", label: "Offline", href: href({ status: "OFFLINE", archived: undefined }) },
              { value: "UNKNOWN", label: adapter === "mock" ? "Simulated" : "Not checked", href: href({ status: "UNKNOWN", archived: undefined }) },
              { value: "ARCHIVED", label: "Archived", href: href({ status: undefined, archived: "true" }) },
            ]}
          />
          <SearchForm action="/routers" q={sp.q} placeholder="Name, address or identity" hidden={{ status: sp.status, archived: sp.archived }} />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={RouterIcon}
            title={query.q || query.status !== "ALL" ? "No routers match" : "No routers registered"}
            description={canWrite ? "Register each MikroTik router with a dedicated API user. Cloudlink reaches it over your private network or VPN." : undefined}
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Router</Th>
                  <Th>Status</Th>
                  <Th>Health</Th>
                  <Th>Load</Th>
                  <Th>Services</Th>
                  <Th className="text-right">Subscriptions</Th>
                  <Th className="text-right">Sessions</Th>
                  <Th className="text-right">Open alerts</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td label="Router">
                      <div className="min-w-0 text-right md:text-left">
                        <Link href={`/routers/${r.id}`} className="font-medium text-accent hover:underline">
                          {r.name}
                        </Link>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {r.host}:{r.apiPort} {r.useTls ? "· TLS" : "· plain API"}
                        </span>
                        {r.branchName ? <span className="block text-xs text-muted-foreground">{r.branchName}</span> : null}
                      </div>
                    </Td>
                    <Td label="Status">
                      <div className="min-w-0 text-right md:text-left">
                        <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                          <RouterStatusBadge status={r.status} adapter={adapter} />
                          {r.maintenanceMode ? <Badge tone="warning">Maintenance</Badge> : null}
                        </span>
                        <span className="block text-xs text-muted-foreground">{r.lastCheckedAt ? `Checked ${formatDateTime(r.lastCheckedAt, tz)}` : "Never checked"}</span>
                      </div>
                    </Td>
                    <Td label="Health">
                      <div className="min-w-0 text-right md:text-left">
                        {r.health.score === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Badge tone={r.health.grade === "good" ? "success" : r.health.grade === "fair" ? "warning" : "danger"}>
                            {r.health.score} · {r.health.grade === "good" ? "Good" : r.health.grade === "fair" ? "Fair" : "Poor"}
                          </Badge>
                        )}
                        <span className="block text-xs text-muted-foreground">{r.availability24h === null ? "No checks in 24 h" : `${r.availability24h}% reachable, 24 h`}</span>
                      </div>
                    </Td>
                    <Td label="Load">
                      {r.latest ? (
                        <div className="min-w-0 text-right text-xs md:text-left">
                          <span className="tabular block">
                            CPU {r.latest.cpuLoad ?? "—"}% · Mem {r.latest.memoryUsedPct ?? "—"}%
                          </span>
                          <span className="block text-muted-foreground">Up {formatDuration(r.latest.uptimeSeconds)}{r.latest.simulated ? " · simulated" : ""}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td label="Services">
                      <span className="flex flex-wrap gap-1">
                        {r.pppoeEnabled ? <Badge tone="neutral">{r.pppoeAuth === "RADIUS" ? "PPPoE · RADIUS" : "PPPoE"}</Badge> : null}
                        {r.hotspotEnabled ? <Badge tone="neutral">Hotspot</Badge> : null}
                      </span>
                    </Td>
                    <Td label="Subscriptions" className="tabular md:text-right">
                      {r.provisionedSubscriptions}
                    </Td>
                    <Td label="Sessions" className="tabular md:text-right">
                      {r.activeSessions}
                    </Td>
                    <Td label="Open alerts" className="tabular md:text-right">
                      {r.openAlerts ? <Badge tone="danger">{r.openAlerts}</Badge> : "0"}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/routers", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
