import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Activity as ActivityIcon, AlertTriangle, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { getRouter, listRouterAlerts } from "@/server/services/routers";
import { listNetworkOperations, listNetworkSessions } from "@/server/services/network";
import { routerReport, routerSnapshots, routerTelemetry, telemetryQuery } from "@/server/services/router-insights";
import type { DiagnosisCheck, LogLine } from "@/server/integrations/network";
import type { SeriesPoint } from "@/server/domain/router-telemetry";
import { listAccessibleBranches } from "@/server/auth/service";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { StatStrip, type StripStat } from "@/components/stat-strip";
import { FilterTabs } from "@/components/list-toolbar";
import { BarSeriesChart, LineSeriesChart, type Series } from "@/components/charts";
import { OperationStatusBadge, RouterStatusBadge } from "@/components/status";
import { AdapterNotice, formatDuration } from "@/components/network-notice";
import { Forbidden } from "@/components/shell/forbidden";
import { cn, formatDateTime, formatMoney } from "@/lib/utils";
import { ArchiveRouterButton, DisconnectSessionDialog, HealthCheckButton, RotateCredentialsDialog, RouterFormDialog, SetupCommandDialog } from "../client";
import { ResolveAlertButton } from "../../sessions/client";
import { MaintenanceDialog, ReachabilityHeatmap, RebootRouterButton, RenameRouterDialog, RouterActionDialog, RouterQueryButton } from "./client";

export const metadata: Metadata = { title: "Router" };

const TABS = ["overview", "performance", "diagnostics", "reports", "activity"] as const;
type Tab = (typeof TABS)[number];

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);
const mbps = (bps: number | null | undefined) => (bps === null || bps === undefined ? "—" : `${(bps / 1_000_000).toLocaleString("en-KE", { maximumFractionDigits: 1 })} Mbps`);
const GRADE = { good: "Good", fair: "Fair", poor: "Poor" } as const;

export default async function RouterDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("routers.read");
  if (!allowed) return <Forbidden what="routers" />;
  let router;
  try {
    router = await getRouter(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  const canWrite = ctx.permissions.has("routers.write") && !router.archivedAt;
  const canOperate = ctx.permissions.has("network.operate") && !router.archivedAt;
  const canSeeNetwork = ctx.permissions.has("network.read");
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "overview";
  const range = telemetryQuery.safeParse({ range: sp.range }).data?.range ?? "24h";
  const href = (patch: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { tab, range: tab === "performance" ? range : undefined, ...patch };
    const q = new URLSearchParams(Object.entries(merged).filter((e): e is [string, string] => Boolean(e[1]) && !(e[0] === "tab" && e[1] === "overview")));
    return `/routers/${id}${q.size ? `?${q}` : ""}`;
  };

  const [telemetry, snapshots, report, alerts, ops, sessions, branches] = await Promise.all([
    tab === "overview" || tab === "performance" ? routerTelemetry(ctx, id, { range: tab === "overview" ? "24h" : range }) : null,
    tab === "diagnostics" && canSeeNetwork ? routerSnapshots(ctx, id) : null,
    tab === "reports" ? routerReport(ctx, id) : null,
    (tab === "overview" || tab === "activity") && canSeeNetwork ? listRouterAlerts(ctx, { routerId: id, status: "OPEN", page: 1, pageSize: 20 }) : null,
    tab === "activity" && canSeeNetwork ? listNetworkOperations(ctx, { routerId: id, status: "ALL", page: 1, pageSize: 15 }) : null,
    tab === "activity" && canSeeNetwork ? listNetworkSessions(ctx, { routerId: id, state: "active", page: 1, pageSize: 20 }) : null,
    canWrite ? listAccessibleBranches(ctx) : Promise.resolve([]),
  ]);

  const detail = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={router.name}
        description={`${router.host ? `${router.host}:${router.apiPort} · ${router.useTls ? "API-SSL (TLS)" : "plain API"}` : "Cloudlink agent (checks in every minute)"} · ${router.pppoeAuth === "RADIUS" ? "PPPoE via RADIUS" : "local PPP secrets"}`}
        actions={
          <>
            {canOperate ? <HealthCheckButton routerId={router.id} /> : null}
            {canWrite ? (
              <RouterFormDialog
                router={{
                  id: router.id,
                  name: router.name,
                  host: router.host,
                  apiPort: router.apiPort,
                  useTls: router.useTls,
                  pppoeAuth: router.pppoeAuth,
                  pppoeEnabled: router.pppoeEnabled,
                  hotspotEnabled: router.hotspotEnabled,
                  hotspotDnsName: router.hotspotDnsName,
                  uplinkInterface: router.uplinkInterface,
                  branchId: router.branchId,
                  notes: router.notes,
                }}
                branches={branches.map((b) => ({ id: b.id, name: b.name }))}
              />
            ) : null}
            {canWrite ? <MaintenanceDialog routerId={router.id} enabled={router.maintenanceMode} note={router.maintenanceNote} /> : null}
            {canWrite ? <SetupCommandDialog routerId={router.id} name={router.name} /> : null}
            {canWrite ? <RotateCredentialsDialog routerId={router.id} /> : null}
            {canWrite ? <ArchiveRouterButton routerId={router.id} name={router.name} /> : null}
          </>
        }
      />
      {router.archivedAt ? <Alert tone="warning" title={`Archived ${formatDateTime(router.archivedAt, tz)}`}>This router is no longer checked or used for operations.</Alert> : null}
      {router.maintenanceMode ? (
        <Alert tone="warning" title="In maintenance">
          {router.maintenanceNote ? `${router.maintenanceNote}. ` : ""}Health checks still run, but no offline alert is raised until maintenance ends.
        </Alert>
      ) : null}
      <AdapterNotice adapter={router.adapter} />

      <FilterTabs
        label="Router sections"
        active={tab}
        items={[
          { value: "overview", label: "Overview", href: href({ tab: "overview", range: undefined }) },
          { value: "performance", label: "Performance", href: href({ tab: "performance" }) },
          ...(canSeeNetwork ? [{ value: "diagnostics", label: "Diagnostics", href: href({ tab: "diagnostics", range: undefined }) }] : []),
          { value: "reports", label: "Reports", href: href({ tab: "reports", range: undefined }) },
          ...(canSeeNetwork ? [{ value: "activity", label: "Activity", href: href({ tab: "activity", range: undefined }), count: router.openAlerts || undefined }] : []),
        ]}
      />

      {tab === "overview" && telemetry ? (
        <>
          <StatStrip stats={overviewStats(telemetry, router.activeSessions)} />
          <div className="grid gap-4 lg:grid-cols-3">
            <ScoreCard score={telemetry.score} simulated={telemetry.simulated} />
            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Status</CardTitle>
                  <CardDescription>From the latest health check. Checks run every five minutes.</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid divide-y divide-border text-sm sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
                    {detail("Reachability", <RouterStatusBadge status={router.status} adapter={router.adapter} />)}
                    {detail("Identity", router.identity ?? "—")}
                    {detail("RouterOS version", router.routerOsVersion ?? "—")}
                    {detail("Board", router.boardName ?? "—")}
                    {detail("Last seen online", router.lastSeenAt ? formatDateTime(router.lastSeenAt, tz) : "Never")}
                    {detail("Last checked", router.lastCheckedAt ? formatDateTime(router.lastCheckedAt, tz) : "Never")}
                    {detail("Uplink interface", router.uplinkInterface ?? (telemetry.reading?.rxBps != null ? "First running Ethernet port" : "Not measured"))}
                    {detail("Open sessions", router.activeSessions)}
                  </dl>
                  {router.lastError ? <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{router.lastError}</p> : null}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Configuration</CardTitle>
                  <CardDescription>Credentials are stored encrypted and are never displayed.</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid divide-y divide-border text-sm sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
                    {detail("Management address", router.host ? <span className="font-mono">{`${router.host}:${router.apiPort}`}</span> : <span className="text-muted-foreground">None. Reached through the Cloudlink agent.</span>)}
                    {detail("Transport", router.useTls ? "TLS (API-SSL)" : "Plain API, private network only")}
                    {detail("PPPoE", router.pppoeEnabled ? (router.pppoeAuth === "RADIUS" ? "Enabled, authenticated by RADIUS" : "Enabled, local secrets") : "Not used")}
                    {detail("Hotspot", router.hotspotEnabled ? `Enabled${router.hotspotDnsName ? ` at ${router.hotspotDnsName}` : ""}` : "Not used")}
                    {detail("Branch", router.branchName ?? "All branches")}
                    {detail("Provisioned subscriptions", router.provisionedSubscriptions)}
                    {detail("Credentials updated", router.credentialsUpdatedAt ? formatDateTime(router.credentialsUpdatedAt, tz) : "Missing")}
                    {detail(
                      "Setup command",
                      router.onboardedAt
                        ? `Used ${formatDateTime(router.onboardedAt, tz)}${router.onboardedFromIp ? ` from ${router.onboardedFromIp}` : ""}`
                        : router.setupExpiresAt && router.setupExpiresAt > new Date()
                          ? `Issued, valid until ${formatDateTime(router.setupExpiresAt, tz)}`
                          : "Not used",
                    )}
                    {router.notes ? detail("Notes", router.notes) : null}
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>
          {alerts && alerts.rows.length ? <AlertsCard alerts={alerts.rows} tz={tz} canResolve={ctx.permissions.has("network.operate")} /> : null}
        </>
      ) : null}

      {tab === "performance" && telemetry ? <Performance telemetry={telemetry} tz={tz} rangeHref={(r) => href({ range: r })} range={range} uplink={router.uplinkInterface} /> : null}

      {tab === "diagnostics" && snapshots ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Router actions</CardTitle>
              <CardDescription>Each action runs as a tracked network operation; its outcome is under Activity. Nothing here accepts arbitrary router commands.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {canOperate ? <RouterQueryButton routerId={router.id} type="router.diagnose" pending={snapshots.pending.diagnosis} /> : null}
              {canOperate ? <RouterQueryButton routerId={router.id} type="router.logs" pending={snapshots.pending.logs} /> : null}
              {canOperate && canWrite ? (
                <>
                  <RouterActionDialog routerId={router.id} type="router.clock" timezone={tz} />
                  {router.hotspotEnabled ? <RouterActionDialog routerId={router.id} type="hotspot.walled_garden" timezone={tz} /> : null}
                  {router.hotspotEnabled ? <RouterActionDialog routerId={router.id} type="hotspot.login_page" timezone={tz} /> : null}
                  <RenameRouterDialog routerId={router.id} current={router.identity} />
                  <RebootRouterButton routerId={router.id} name={router.name} sessions={router.activeSessions} />
                </>
              ) : null}
              {!canOperate ? <p className="text-sm text-muted-foreground">You can view results; running actions needs the “Execute approved network operations” permission.</p> : null}
            </CardContent>
            <CardContent className="border-t border-border pt-4 text-xs text-muted-foreground">
              Configuration backups are not taken through the API: export them on the router (System → Backup, or <span className="font-mono">/export</span>) and keep them off the router.
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <DiagnosisCard snapshot={snapshots.diagnosis} pending={snapshots.pending.diagnosis} tz={tz} />
            <LogsCard snapshot={snapshots.logs} pending={snapshots.pending.logs} tz={tz} />
          </div>
        </div>
      ) : null}

      {tab === "reports" && report ? <Reports report={report} /> : null}

      {tab === "activity" ? (
        <div className="space-y-4">
          {alerts ? (
            alerts.rows.length ? (
              <AlertsCard alerts={alerts.rows} tz={tz} canResolve={ctx.permissions.has("network.operate")} />
            ) : (
              <Card>
                <CardContent className="py-4 text-sm text-muted-foreground">No open alerts for this router.</CardContent>
              </Card>
            )
          ) : null}
          {ops ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent operations</CardTitle>
                <CardDescription>
                  <Link href={`/sessions?tab=operations&routerId=${router.id}`} className="text-accent hover:underline">
                    All operations on this router
                  </Link>
                </CardDescription>
              </CardHeader>
              {ops.rows.length === 0 ? (
                <EmptyState title="No operations yet" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Operation</Th>
                      <Th>Target</Th>
                      <Th>Status</Th>
                      <Th>Requested</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {ops.rows.map((o) => {
                      const p = o.params as Record<string, unknown>;
                      return (
                        <Tr key={o.id}>
                          <Td label="Operation">
                            <Link href={`/sessions/operations/${o.id}`} className="text-accent hover:underline">
                              {o.label}
                            </Link>
                          </Td>
                          <Td label="Target">{o.subscriber ? `${o.subscriber.displayName} (${o.subscriber.accountNumber})` : String(p.username ?? p.name ?? p.profile ?? p.host ?? "This router")}</Td>
                          <Td label="Status">
                            <OperationStatusBadge status={o.status} />
                          </Td>
                          <Td label="Requested">{formatDateTime(o.createdAt, tz)}</Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </Card>
          ) : null}
          {sessions ? (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>Active sessions</CardTitle>
                  <CardDescription>{sessions.lastSyncedAt ? `Last synced ${formatDateTime(sessions.lastSyncedAt, tz)}` : "Not synced yet"}</CardDescription>
                </div>
                {canOperate ? <DisconnectSessionDialog routerId={router.id} /> : null}
              </CardHeader>
              {sessions.rows.length === 0 ? (
                <EmptyState title="No active sessions recorded" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>User</Th>
                      <Th>Type</Th>
                      <Th>Address</Th>
                      <Th>Uptime</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {sessions.rows.map((s) => (
                      <Tr key={s.id}>
                        <Td label="User">
                          <div className="min-w-0 text-right md:text-left">
                            <span className="font-mono text-xs">{s.username}</span>
                            {s.subscriber ? (
                              <Link href={`/subscribers/${s.subscriber.id}`} className="block text-xs text-accent hover:underline">
                                {s.subscriber.displayName}
                              </Link>
                            ) : null}
                          </div>
                        </Td>
                        <Td label="Type">{s.kind === "PPPOE" ? "PPPoE" : s.kind === "BINDING" ? "Device (MAC)" : "Hotspot"}</Td>
                        <Td label="Address" className="font-mono text-xs">
                          {s.address ?? "—"}
                        </Td>
                        <Td label="Uptime">{formatDuration(s.uptimeSeconds)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Telemetry = Awaited<ReturnType<typeof routerTelemetry>>;

function overviewStats(t: Telemetry, sessions: number): StripStat[] {
  const r = t.reading;
  const score = t.score;
  return [
    {
      label: "Health score",
      value: score.score === null ? "—" : score.score,
      hint: score.grade ? `${GRADE[score.grade]}${t.simulated ? " · simulated" : ""}` : "No checks in 24 h",
      tone: score.grade === "good" ? "success" : score.grade === "poor" ? "danger" : "default",
    },
    { label: "Availability 24 h", value: pct(t.availability), hint: `${t.checks} check${t.checks === 1 ? "" : "s"}` },
    { label: "CPU", value: pct(r?.cpuLoad), hint: r?.temperatureC != null ? `${r.temperatureC} °C` : undefined },
    { label: "Memory used", value: pct(r?.memoryUsedPct), hint: r?.diskUsedPct != null ? `Storage ${r.diskUsedPct}%` : undefined },
    { label: "Router uptime", value: r?.uptimeSeconds != null ? formatDuration(r.uptimeSeconds) : "—", hint: r?.responseMs != null ? `API ${r.responseMs} ms` : undefined },
    { label: "Uplink now", value: mbps(r?.rxBps), hint: r?.txBps != null ? `${mbps(r.txBps)} up` : undefined },
    { label: "Sessions", value: sessions, hint: "Open now" },
  ];
}

function ScoreCard({ score, simulated }: { score: Telemetry["score"]; simulated: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Health score</CardTitle>
        <CardDescription>Last 24 hours of health checks{simulated ? ". Simulated readings (mock adapter)." : "."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {score.score === null ? (
          <p className="text-sm text-muted-foreground">No health checks in the last 24 hours.</p>
        ) : (
          <>
            <p className="flex items-baseline gap-2">
              <span className="tabular text-4xl font-semibold tracking-tight">{score.score}</span>
              <span className="text-sm text-muted-foreground">/ 100</span>
              <Badge tone={score.grade === "good" ? "success" : score.grade === "fair" ? "warning" : "danger"} className="ml-auto">
                {GRADE[score.grade!]}
              </Badge>
            </p>
            {score.cap ? <p className="text-xs text-danger">Capped at 25: {score.cap.toLowerCase()}.</p> : null}
            <ul className="space-y-2.5">
              {score.parts.map((p) => (
                <li key={p.key} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span>{p.label}</span>
                    <span className="tabular text-muted-foreground">
                      {p.points} / {p.max}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(p.points / p.max) * 100}%` }} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{p.detail}</p>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Readings a router does not report are left out and the rest rescaled to 100.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AlertsCard({ alerts, tz, canResolve }: { alerts: Array<{ id: string; message: string; severity: string; createdAt: Date; operationId: string | null }>; tz: string; canResolve: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open alerts</CardTitle>
      </CardHeader>
      <ul className="divide-y divide-border">
        {alerts.map((a) => (
          <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <p className="font-medium">{a.message}</p>
              <p className="text-xs text-muted-foreground">
                {a.severity === "critical" ? "Critical" : "Warning"} · {formatDateTime(a.createdAt, tz)}
                {a.operationId ? (
                  <>
                    {" · "}
                    <Link href={`/sessions/operations/${a.operationId}`} className="text-accent hover:underline">
                      View operation
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
            {canResolve ? <ResolveAlertButton alertId={a.id} message={a.message} /> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────── Performance ─────────

function ChartCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SeriesTable({ points, columns, tz }: { points: SeriesPoint[]; columns: Array<{ key: keyof SeriesPoint; label: string; format?: (v: number) => string }>; tz: string }) {
  const rows = points.filter((p) => p.checks > 0);
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs text-accent">Data table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-muted text-left">
            <tr>
              <th className="px-2 py-1.5 font-medium">Time</th>
              {columns.map((c) => (
                <th key={c.key} className="px-2 py-1.5 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((p) => (
              <tr key={p.t}>
                <td className="px-2 py-1">{formatDateTime(new Date(p.t), tz)}</td>
                {columns.map((c) => {
                  const v = p[c.key] as number | null;
                  return (
                    <td key={c.key} className="tabular px-2 py-1 text-right">
                      {v === null ? "—" : c.format ? c.format(v) : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const pick = (points: SeriesPoint[], keys: Array<keyof SeriesPoint>) => points.map((p) => ({ t: p.t, ...Object.fromEntries(keys.map((k) => [k, p[k] as number | null])) }));

function Performance({ telemetry: t, tz, range, rangeHref, uplink }: { telemetry: Telemetry; tz: string; range: string; rangeHref: (r: string) => string; uplink: string | null }) {
  const has = (k: keyof SeriesPoint) => t.series.some((p) => p[k] !== null);
  const cpuMem: Series[] = [
    { key: "cpu", label: "CPU load", slot: 1 },
    { key: "memory", label: "Memory used", slot: 2 },
  ];
  const traffic: Series[] = [
    { key: "rxMbps", label: "Download (received)", slot: 1 },
    { key: "txMbps", label: "Upload (sent)", slot: 2 },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <FilterTabs
          label="Time range"
          active={range}
          items={[
            { value: "24h", label: "24 hours", href: rangeHref("24h") },
            { value: "7d", label: "7 days", href: rangeHref("7d") },
            { value: "30d", label: "30 days", href: rangeHref("30d") },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {t.checks} checks · averaged per {t.bucketMinutes >= 60 ? `${t.bucketMinutes / 60} h` : `${t.bucketMinutes} min`}
          {t.simulated ? " · simulated readings (mock adapter)" : ""}
        </p>
      </div>
      {t.checks === 0 ? (
        <Card>
          <EmptyState icon={ActivityIcon} title="No health checks in this period" description="Checks run every five minutes once the worker is running. Use “Check now” to take one." />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="CPU and memory" description="Percent of capacity, averaged over each interval.">
              <LineSeriesChart data={pick(t.series, ["cpu", "memory"])} series={cpuMem} unit="%" timeZone={tz} yMax={100} digits={0} ariaLabel="CPU load and memory used over time, percent" />
              <SeriesTable points={t.series} tz={tz} columns={[{ key: "cpu", label: "CPU %" }, { key: "memory", label: "Memory %" }]} />
            </ChartCard>
            <ChartCard title="Uplink traffic" description={`Mbps on ${uplink ?? "the first running Ethernet port"}, sampled at each check (not a full traffic graph).`}>
              {has("rxMbps") ? (
                <>
                  <LineSeriesChart data={pick(t.series, ["rxMbps", "txMbps"])} series={traffic} unit="Mbps" timeZone={tz} ariaLabel="Uplink download and upload over time, megabits per second" />
                  <SeriesTable points={t.series} tz={tz} columns={[{ key: "rxMbps", label: "Download Mbps" }, { key: "txMbps", label: "Upload Mbps" }]} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No traffic readings. Set the uplink interface on the router (Edit) if the first Ethernet port is not the uplink.</p>
              )}
            </ChartCard>
            <ChartCard title="Open sessions" description="PPPoE, hotspot and device sessions at each check.">
              <LineSeriesChart data={pick(t.series, ["sessions"])} series={[{ key: "sessions", label: "Sessions", slot: 1 }]} unit="sessions" timeZone={tz} digits={0} ariaLabel="Open sessions over time" />
              <SeriesTable points={t.series} tz={tz} columns={[{ key: "sessions", label: "Sessions" }]} />
            </ChartCard>
            <ChartCard title="API response time" description="Time to connect, log in and read the router over its API (not an ICMP ping).">
              <LineSeriesChart data={pick(t.series, ["responseMs"])} series={[{ key: "responseMs", label: "Response", slot: 1 }]} unit="ms" timeZone={tz} digits={0} ariaLabel="API response time over time, milliseconds" />
              <SeriesTable points={t.series} tz={tz} columns={[{ key: "responseMs", label: "Response ms" }]} />
            </ChartCard>
            {has("temperature") ? (
              <ChartCard title="Temperature" description="Board temperature, °C.">
                <LineSeriesChart data={pick(t.series, ["temperature"])} series={[{ key: "temperature", label: "Temperature", slot: 1 }]} unit="°C" timeZone={tz} ariaLabel="Board temperature over time, degrees Celsius" />
                <SeriesTable points={t.series} tz={tz} columns={[{ key: "temperature", label: "°C" }]} />
              </ChartCard>
            ) : null}
          </div>
          <ChartCard title="Reachability, last 7 days" description="Share of health checks that reached the router, by local hour.">
            <ReachabilityHeatmap days={t.heatmap} />
          </ChartCard>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Outages in this period</CardTitle>
          <CardDescription>Consecutive failed checks. Times are measured between checks, so durations are approximate.</CardDescription>
        </CardHeader>
        {t.incidents.length === 0 ? (
          <CardContent className="text-sm text-muted-foreground">{t.checks ? "No failed checks." : "No checks yet."}</CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Started</Th>
                <Th>Ended</Th>
                <Th className="text-right">Duration</Th>
                <Th className="text-right">Failed checks</Th>
              </tr>
            </THead>
            <TBody>
              {t.incidents.map((i) => (
                <Tr key={i.startedAt.toISOString()}>
                  <Td label="Started">{formatDateTime(i.startedAt, tz)}</Td>
                  <Td label="Ended">{i.endedAt ? formatDateTime(i.endedAt, tz) : <Badge tone="danger">Ongoing</Badge>}</Td>
                  <Td label="Duration" className="tabular md:text-right">
                    {formatDuration(i.durationSeconds)}
                  </Td>
                  <Td label="Failed checks" className="tabular md:text-right">
                    {i.failedChecks}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ───────── Diagnostics ─────────

const CHECK_STATE = {
  ok: { icon: CheckCircle2, label: "OK", className: "text-success" },
  warning: { icon: AlertTriangle, label: "Warning", className: "text-warning" },
  problem: { icon: XCircle, label: "Problem", className: "text-danger" },
  skipped: { icon: MinusCircle, label: "Skipped", className: "text-muted-foreground" },
} as const;

type Snapshot = { data: unknown; simulated: boolean; takenAt: Date } | null;

function DiagnosisCard({ snapshot, pending, tz }: { snapshot: Snapshot; pending: boolean; tz: string }) {
  const checks = ((snapshot?.data as { checks?: DiagnosisCheck[] } | undefined)?.checks ?? []) as DiagnosisCheck[];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Diagnosis</CardTitle>
        <CardDescription>
          {snapshot ? `Taken ${formatDateTime(snapshot.takenAt, tz)}${snapshot.simulated ? " · simulated (mock adapter)" : ""}` : "Not run yet."}
          {pending ? " A new diagnosis is running." : ""}
        </CardDescription>
      </CardHeader>
      {checks.length ? (
        <ul className="divide-y divide-border">
          {checks.map((c) => {
            const s = CHECK_STATE[c.status];
            const Icon = s.icon;
            return (
              <li key={c.id} className="flex gap-3 px-5 py-2.5 text-sm">
                <Icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.label} <span className={cn("text-xs font-normal", s.className)}>· {s.label}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{c.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <CardContent className="text-sm text-muted-foreground">Run a diagnosis to check the router&apos;s API access, clock, PPPoE and hotspot servers, walled garden, RADIUS and plan profiles.</CardContent>
      )}
    </Card>
  );
}

function LogsCard({ snapshot, pending, tz }: { snapshot: Snapshot; pending: boolean; tz: string }) {
  const lines = ((snapshot?.data as { lines?: LogLine[] } | undefined)?.lines ?? []) as LogLine[];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Router log</CardTitle>
        <CardDescription>
          {snapshot ? `Latest ${lines.length} lines, fetched ${formatDateTime(snapshot.takenAt, tz)}${snapshot.simulated ? " · simulated (mock adapter)" : ""}` : "Not fetched yet."}
          {pending ? " Fetching new lines." : ""}
        </CardDescription>
      </CardHeader>
      {lines.length ? (
        <div className="max-h-[28rem] overflow-auto border-t border-border">
          <table className="w-full min-w-[36rem] text-xs">
            <thead className="sticky top-0 bg-surface-muted text-left">
              <tr>
                <th className="px-3 py-1.5 font-medium">Time</th>
                <th className="px-3 py-1.5 font-medium">Topics</th>
                <th className="px-3 py-1.5 font-medium">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {lines.map((l, i) => (
                <tr key={i} className={cn(/error|critical/.test(l.topics) && "text-danger", /warning/.test(l.topics) && "text-warning")}>
                  <td className="px-3 py-1 whitespace-nowrap">{l.time}</td>
                  <td className="px-3 py-1 whitespace-nowrap">{l.topics}</td>
                  <td className="px-3 py-1 break-words">{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <CardContent className="text-sm text-muted-foreground">Fetch the log to see the router&apos;s latest 100 lines.</CardContent>
      )}
    </Card>
  );
}

// ───────── Reports ─────────

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Active", PENDING: "Pending", SUSPENDED: "Suspended", EXPIRED: "Expired", CANCELLED: "Cancelled" };

function Reports({ report }: { report: Awaited<ReturnType<typeof routerReport>> }) {
  const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-KE", { day: "numeric", month: "short", timeZone: "UTC" });
  const subs = Object.entries(report.subscriptions);
  return (
    <div className="space-y-4">
      <StatStrip
        stats={[
          { label: "Sessions, 30 days", value: report.sessions.total.toLocaleString("en-KE") },
          { label: "Unique users", value: report.sessions.uniqueUsers.toLocaleString("en-KE") },
          { label: "Average session", value: report.sessions.averageSeconds === null ? "—" : formatDuration(report.sessions.averageSeconds), hint: "Sessions that ended" },
          ...subs.map(([status, n]) => ({ label: `${STATUS_LABEL[status] ?? status} subscriptions`, value: n })),
        ]}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        {report.collections ? (
          <ChartCard title="Collections" description="Payments applied to invoices of subscriptions on this router, by month.">
            {report.collections.every((c) => Number(c.amount) === 0) ? (
              <p className="text-sm text-muted-foreground">No payments applied to this router&apos;s subscriptions in the last six months.</p>
            ) : (
              <>
                <BarSeriesChart data={report.collections.map((c) => ({ month: c.month, amount: c.amount }))} xKey="month" series={[{ key: "amount", label: "Collected", slot: 1 }]} currency={report.currency} ariaLabel="Collections by month" />
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-xs text-accent">Data table</summary>
                  <table className="mt-2 w-full text-xs">
                    <tbody className="divide-y divide-border">
                      {report.collections.map((c) => (
                        <tr key={c.month}>
                          <td className="py-1">{c.month}</td>
                          <td className="tabular py-1 text-right">{formatMoney(c.amount, report.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            )}
          </ChartCard>
        ) : null}
        <ChartCard title="Sessions per day" description="Sessions that started on this router (last 30 days), and how many different users they belonged to.">
          {report.sessions.days.length ? (
            <BarSeriesChart
              data={report.sessions.days.map((d) => ({ day: dayLabel(d.day), sessions: d.sessions, users: d.users }))}
              xKey="day"
              series={[
                { key: "sessions", label: "Sessions", slot: 1 },
                { key: "users", label: "Unique users", slot: 2 },
              ]}
              ariaLabel="Sessions and unique users per day"
            />
          ) : (
            <p className="text-sm text-muted-foreground">No sessions recorded in the last 30 days.</p>
          )}
        </ChartCard>
        <ChartCard title="Peak hours" description="Average open sessions by local hour, from health checks over the last 30 days.">
          {report.peakHours.some((h) => h.sessions !== null) ? (
            <>
              <BarSeriesChart data={report.peakHours.map((h) => ({ hour: `${String(h.hour).padStart(2, "0")}:00`, sessions: h.sessions ?? 0 }))} xKey="hour" series={[{ key: "sessions", label: "Average sessions", slot: 1 }]} ariaLabel="Average open sessions by hour of day" />
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-xs text-accent">Data table</summary>
                <table className="mt-2 w-full text-xs">
                  <tbody className="divide-y divide-border">
                    {report.peakHours.map((h) => (
                      <tr key={h.hour}>
                        <td className="py-1">{String(h.hour).padStart(2, "0")}:00</td>
                        <td className="tabular py-1 text-right">{h.sessions === null ? "No checks" : h.sessions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No health checks with session counts yet.</p>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
