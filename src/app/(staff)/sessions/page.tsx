import type { Metadata } from "next";
import Link from "next/link";
import { Activity, BellOff, ListChecks } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import type { StaffContext } from "@/server/auth/context";
import { listNetworkOperations, listNetworkSessions, operationListQuery, sessionListQuery } from "@/server/services/network";
import { alertListQuery, listRouterAlerts } from "@/server/services/routers";
import { networkAdapterName } from "@/server/integrations/network";
import { Card } from "@/components/ui/card";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { OperationStatusBadge } from "@/components/status";
import { AdapterNotice, formatBytes, formatDuration } from "@/components/network-notice";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { LiveSessionsControl, RefreshSessionsButton, ResolveAlertButton } from "./client";

export const metadata: Metadata = { title: "Network sessions" };

type SP = Record<string, string | undefined>;
interface TabProps {
  ctx: StaffContext;
  sp: SP;
}
const TABS = ["sessions", "operations", "alerts"] as const;

export default async function NetworkPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { ctx, allowed } = await getStaffContextWith("network.read");
  if (!allowed) return <Forbidden what="network sessions" />;
  const sp = await searchParams;
  const tab = TABS.includes(sp.tab as (typeof TABS)[number]) ? (sp.tab as (typeof TABS)[number]) : "sessions";
  const adapter = networkAdapterName();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network sessions"
        description="Live PPPoE and hotspot sessions, the durable log of every router or RADIUS change, and network alerts."
        actions={tab === "sessions" ? <RefreshSessionsButton /> : null}
      />
      <AdapterNotice adapter={adapter} />
      <FilterTabs
        label="Network views"
        active={tab}
        items={[
          { value: "sessions", label: "Sessions", href: "/sessions" },
          { value: "operations", label: "Operations", href: "/sessions?tab=operations" },
          { value: "alerts", label: "Alerts", href: "/sessions?tab=alerts" },
        ]}
      />
      {tab === "sessions" ? <SessionsTab ctx={ctx} sp={sp} adapter={adapter} /> : tab === "operations" ? <OperationsTab ctx={ctx} sp={sp} /> : <AlertsTab ctx={ctx} sp={sp} />}
    </div>
  );
}

async function SessionsTab({ ctx, sp, adapter }: TabProps & { adapter: string }) {
  const parsed = sessionListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : sessionListQuery.parse({});
  const { rows, total, lastSyncedAt, online } = await listNetworkSessions(ctx, query);
  const tz = ctx.organization.timezone;
  const current = { q: sp.q, state: sp.state, routerId: sp.routerId };
  // Twice the scheduled sync interval: older data means the worker is not running or cannot reach the routers.
  const staleMinutes = minutesSince(lastSyncedAt);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Online now" value={online.pppoe + online.hotspot} />
        <Stat label="PPPoE" value={online.pppoe} />
        <Stat label="Hotspot" value={online.hotspot} />
      </div>
      {adapter !== "disabled" && staleMinutes !== null && staleMinutes >= 10 ? (
        <Alert tone="warning" title="Session data may be out of date">
          The last successful sync was {staleMinutes} minutes ago. Check that the background worker is running and can reach your routers.
        </Alert>
      ) : null}
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Session state"
            active={query.state}
            items={(["active", "ended", "all"] as const).map((s) => ({ value: s, label: s === "active" ? "Active" : s === "ended" ? "Ended" : "All", href: buildHref("/sessions", current, { state: s === "active" ? undefined : s, page: undefined }) }))}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <LiveSessionsControl lastSyncedAt={lastSyncedAt?.toISOString() ?? null} />
            <SearchForm action="/sessions" q={sp.q} placeholder="Username, IP or MAC" hidden={{ state: sp.state, routerId: sp.routerId }} />
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={Activity}
            title={query.state === "active" ? "Nobody is online" : "No sessions recorded"}
            description={
              adapter === "mock"
                ? "Test mode simulates sessions for subscribers whose network access was enabled, and for active hotspot vouchers. No router is contacted."
                : "Sessions appear after the next sync from your routers or RADIUS accounting."
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>User</Th>
                  <Th>Router</Th>
                  <Th>Address / MAC</Th>
                  <Th>Uptime</Th>
                  <Th>Traffic in / out</Th>
                  <Th>Source</Th>
                  <Th>Last seen</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((s) => (
                  <Tr key={s.id}>
                    <Td label="User">
                      <div className="min-w-0 text-right md:text-left">
                        <span className="font-mono text-xs">{s.username}</span> <Badge tone="neutral">{s.kind === "PPPOE" ? "PPPoE" : "Hotspot"}</Badge>
                        {s.subscriber ? (
                          <Link href={`/subscribers/${s.subscriber.id}`} className="block text-xs text-accent hover:underline">
                            {s.subscriber.displayName} · {s.subscriber.accountNumber}
                          </Link>
                        ) : null}
                      </div>
                    </Td>
                    <Td label="Router">
                      <Link href={`/routers/${s.routerId}`} className="hover:underline">
                        {s.routerName ?? "—"}
                      </Link>
                    </Td>
                    <Td label="Address / MAC" className="font-mono text-xs">
                      <div className="min-w-0 text-right md:text-left">
                        {s.address ?? "—"}
                        {s.macAddress ? <span className="block text-muted-foreground">{s.macAddress}</span> : null}
                      </div>
                    </Td>
                    <Td label="Uptime">{formatDuration(s.uptimeSeconds)}</Td>
                    <Td label="Traffic in / out" className="tabular">
                      {formatBytes(s.bytesIn)} / {formatBytes(s.bytesOut)}
                    </Td>
                    <Td label="Source">{s.source === "radius_accounting" ? "RADIUS accounting" : s.source === "router_api" ? "Router API" : <Badge tone="warning">Simulated</Badge>}</Td>
                    <Td label="Last seen">
                      <div className="min-w-0 text-right md:text-left">
                        {formatDateTime(s.lastSeenAt, tz)}
                        {s.endedAt ? <span className="block text-xs text-muted-foreground">Ended {formatDateTime(s.endedAt, tz)}</span> : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/sessions", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}

function minutesSince(at: Date | null): number | null {
  return at ? Math.floor((Date.now() - at.getTime()) / 60_000) : null;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <div className="px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="tabular text-2xl font-semibold">{value.toLocaleString("en-KE")}</p>
      </div>
    </Card>
  );
}

async function OperationsTab({ ctx, sp }: TabProps) {
  const parsed = operationListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : operationListQuery.parse({});
  const { rows, total, counts } = await listNetworkOperations(ctx, query);
  const tz = ctx.organization.timezone;
  const current = { tab: "operations", status: sp.status, routerId: sp.routerId, subscriptionId: sp.subscriptionId };
  const statusHref = (status?: string) => buildHref("/sessions", current, { status, page: undefined });
  const attention = (counts.FAILED ?? 0) + (counts.RETRYING ?? 0);
  return (
    <Card>
      <div className="border-b border-border p-4">
        <FilterTabs
          label="Operation status"
          active={query.status}
          items={[
            { value: "ALL", label: "All", href: statusHref(undefined) },
            { value: "ATTENTION", label: "Needs attention", count: attention, href: statusHref("ATTENTION") },
            ...(["QUEUED", "RETRYING", "FAILED", "SUCCEEDED", "SIMULATED", "CANCELLED"] as const).map((s) => ({
              value: s,
              label: s.charAt(0) + s.slice(1).toLowerCase(),
              count: counts[s] ?? 0,
              href: statusHref(s),
            })),
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={ListChecks} title="No operations" description="Operations are created when access is provisioned, when billing status changes, or when staff request one." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Operation</Th>
                <Th>Target</Th>
                <Th>Router</Th>
                <Th>Status</Th>
                <Th className="text-right">Attempts</Th>
                <Th>Requested</Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((o) => (
                <Tr key={o.id}>
                  <Td label="Operation">
                    <div className="min-w-0 text-right md:text-left">
                      <Link href={`/sessions/operations/${o.id}`} className="font-medium text-accent hover:underline">
                        {o.label}
                      </Link>
                      {o.resultDetail ? <span className="line-clamp-2 block max-w-md break-words text-xs text-muted-foreground">{o.resultDetail}</span> : null}
                    </div>
                  </Td>
                  <Td label="Target">
                    {o.subscriber ? (
                      <Link href={`/subscribers/${o.subscriber.id}`} className="hover:underline">
                        {o.subscriber.displayName}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{String((o.params as Record<string, unknown>).username ?? (o.redemptionId ? "Voucher" : "—"))}</span>
                    )}
                  </Td>
                  <Td label="Router">{o.routerName ?? "—"}</Td>
                  <Td label="Status">
                    <OperationStatusBadge status={o.status} />
                  </Td>
                  <Td label="Attempts" className="tabular md:text-right">
                    {o.attempts}/{o.maxAttempts}
                  </Td>
                  <Td label="Requested">
                    <div className="min-w-0 text-right md:text-left">
                      {formatDateTime(o.createdAt, tz)}
                      <span className="block text-xs text-muted-foreground">{o.requestedBy === "user" ? "Staff" : `System · ${o.requestedBy}`}</span>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/sessions", current, { page: p })} />
        </>
      )}
    </Card>
  );
}

async function AlertsTab({ ctx, sp }: TabProps) {
  const parsed = alertListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : alertListQuery.parse({});
  const { rows, total } = await listRouterAlerts(ctx, query);
  const tz = ctx.organization.timezone;
  const current = { tab: "alerts", status: sp.status };
  const canOperate = ctx.permissions.has("network.operate");
  return (
    <Card>
      <div className="border-b border-border p-4">
        <FilterTabs
          label="Alert status"
          active={query.status}
          items={(["OPEN", "RESOLVED", "ALL"] as const).map((s) => ({ value: s, label: s === "OPEN" ? "Open" : s === "RESOLVED" ? "Resolved" : "All", href: buildHref("/sessions", current, { status: s === "OPEN" ? undefined : s, page: undefined }) }))}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={BellOff} title={query.status === "OPEN" ? "No open alerts" : "No alerts"} />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.status === "RESOLVED" ? "neutral" : a.severity === "critical" ? "danger" : "warning"}>
                      {a.status === "RESOLVED" ? "Resolved" : a.severity === "critical" ? "Critical" : "Warning"}
                    </Badge>
                    <span className="font-medium">{a.message}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.type === "ROUTER_OFFLINE" ? "Router unreachable" : a.type === "OPERATION_FAILED" ? "Operation failed" : "Operation not progressing"} · raised {formatDateTime(a.createdAt, tz)}
                    {a.resolvedAt ? ` · resolved ${formatDateTime(a.resolvedAt, tz)}` : ""}
                    {a.routerId ? (
                      <>
                        {" · "}
                        <Link href={`/routers/${a.routerId}`} className="text-accent hover:underline">
                          {a.routerName ?? "Router"}
                        </Link>
                      </>
                    ) : null}
                    {a.operationId ? (
                      <>
                        {" · "}
                        <Link href={`/sessions/operations/${a.operationId}`} className="text-accent hover:underline">
                          Operation
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                {canOperate && a.status === "OPEN" ? <ResolveAlertButton alertId={a.id} message={a.message} /> : null}
              </li>
            ))}
          </ul>
          <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/sessions", current, { page: p })} />
        </>
      )}
    </Card>
  );
}
