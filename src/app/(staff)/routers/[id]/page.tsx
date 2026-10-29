import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getRouter, listRouterAlerts } from "@/server/services/routers";
import { listNetworkOperations, listNetworkSessions } from "@/server/services/network";
import { listAccessibleBranches } from "@/server/auth/service";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { OperationStatusBadge, RouterStatusBadge } from "@/components/status";
import { AdapterNotice, formatDuration } from "@/components/network-notice";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { ArchiveRouterButton, DisconnectSessionDialog, HealthCheckButton, RotateCredentialsDialog, RouterFormDialog, SetupCommandDialog } from "../client";
import { ResolveAlertButton } from "../../sessions/client";

export const metadata: Metadata = { title: "Router" };

export default async function RouterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
  const [ops, alerts, sessions, branches] = await Promise.all([
    canSeeNetwork ? listNetworkOperations(ctx, { routerId: id, status: "ALL", page: 1, pageSize: 10 }) : null,
    canSeeNetwork ? listRouterAlerts(ctx, { routerId: id, status: "OPEN", page: 1, pageSize: 20 }) : null,
    canSeeNetwork ? listNetworkSessions(ctx, { routerId: id, state: "active", page: 1, pageSize: 20 }) : null,
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
        description={`${router.host}:${router.apiPort} · ${router.useTls ? "API-SSL (TLS)" : "plain API"} · ${router.pppoeAuth === "RADIUS" ? "PPPoE via RADIUS" : "local PPP secrets"}`}
        actions={
          <>
            {canOperate ? <HealthCheckButton routerId={router.id} /> : null}
            {canWrite ? (
              <RouterFormDialog
                router={{ id: router.id, name: router.name, host: router.host, apiPort: router.apiPort, useTls: router.useTls, pppoeAuth: router.pppoeAuth, pppoeEnabled: router.pppoeEnabled, hotspotEnabled: router.hotspotEnabled, hotspotDnsName: router.hotspotDnsName, branchId: router.branchId, notes: router.notes }}
                branches={branches.map((b) => ({ id: b.id, name: b.name }))}
              />
            ) : null}
            {canWrite ? <SetupCommandDialog routerId={router.id} name={router.name} /> : null}
            {canWrite ? <RotateCredentialsDialog routerId={router.id} /> : null}
            {canWrite ? <ArchiveRouterButton routerId={router.id} name={router.name} /> : null}
          </>
        }
      />
      {router.archivedAt ? <Alert tone="warning" title={`Archived ${formatDateTime(router.archivedAt, tz)}`}>This router is no longer checked or used for operations.</Alert> : null}
      <AdapterNotice adapter={router.adapter} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>From the latest health check (runs every 15 minutes).</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {detail("Reachability", <RouterStatusBadge status={router.status} adapter={router.adapter} />)}
              {detail("Identity", router.identity ?? "—")}
              {detail("RouterOS version", router.routerOsVersion ?? "—")}
              {detail("Board", router.boardName ?? "—")}
              {detail("Last seen online", router.lastSeenAt ? formatDateTime(router.lastSeenAt, tz) : "Never")}
              {detail("Last checked", router.lastCheckedAt ? formatDateTime(router.lastCheckedAt, tz) : "Never")}
              {router.lastError ? detail("Last error", <span className="text-danger">{router.lastError}</span>) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Credentials are stored encrypted and are never displayed.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {detail("Management address", <span className="font-mono">{`${router.host}:${router.apiPort}`}</span>)}
              {detail("Transport", router.useTls ? "TLS (API-SSL)" : "Plain API, private network only")}
              {detail("PPPoE", router.pppoeEnabled ? (router.pppoeAuth === "RADIUS" ? "Enabled, authenticated by RADIUS" : "Enabled, local secrets") : "Not used")}
              {detail("Hotspot", router.hotspotEnabled ? "Enabled" : "Not used")}
              {detail("Branch", router.branchName ?? "All branches")}
              {detail("Provisioned subscriptions", router.provisionedSubscriptions)}
              {detail("Credentials updated", router.credentialsUpdatedAt ? formatDateTime(router.credentialsUpdatedAt, tz) : "Missing")}
              {detail("Setup command", router.onboardedAt ? `Used ${formatDateTime(router.onboardedAt, tz)}${router.onboardedFromIp ? ` from ${router.onboardedFromIp}` : ""}` : router.setupExpiresAt && router.setupExpiresAt > new Date() ? `Issued, valid until ${formatDateTime(router.setupExpiresAt, tz)}` : "Not used")}
              {router.notes ? detail("Notes", router.notes) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      {alerts ? (
        <Card>
          <CardHeader>
            <CardTitle>Open alerts</CardTitle>
          </CardHeader>
          {alerts.rows.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">No open alerts for this router.</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {alerts.rows.map((a) => (
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
                  {ctx.permissions.has("network.operate") ? <ResolveAlertButton alertId={a.id} message={a.message} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
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
                {ops.rows.map((o) => (
                  <Tr key={o.id}>
                    <Td label="Operation">
                      <Link href={`/sessions/operations/${o.id}`} className="text-accent hover:underline">
                        {o.label}
                      </Link>
                    </Td>
                    <Td label="Target">{o.subscriber ? `${o.subscriber.displayName} (${o.subscriber.accountNumber})` : String((o.params as Record<string, unknown>).username ?? "—")}</Td>
                    <Td label="Status">
                      <OperationStatusBadge status={o.status} />
                    </Td>
                    <Td label="Requested">{formatDateTime(o.createdAt, tz)}</Td>
                  </Tr>
                ))}
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
            <EmptyState title="No active sessions recorded" description={router.adapter === "mock" ? "The mock adapter does not read sessions from routers." : undefined} />
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
                    <Td label="Type">{s.kind === "PPPOE" ? "PPPoE" : "Hotspot"}</Td>
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
  );
}
