import Link from "next/link";
import { Router as RouterIcon } from "lucide-react";
import type { StaffContext } from "@/server/auth/context";
import { subscriptionNetwork } from "@/server/services/network";
import { routerOptions } from "@/server/services/routers";
import { networkAdapterName } from "@/server/integrations/network";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { NetworkStatusBadge, OperationStatusBadge } from "@/components/status";
import { formatDuration } from "@/components/network-notice";
import { formatDateTime } from "@/lib/utils";
import { NetworkActions } from "./network-client";

interface SubscriptionSummary {
  id: string;
  packageName: string;
  serviceType: string;
  status: string;
}

/** PPPoE access per subscription: router, username, network status (separate from billing), last operation. */
export async function NetworkAccessCard({ ctx, subscriptions }: { ctx: StaffContext; subscriptions: SubscriptionSummary[] }) {
  const tz = ctx.organization.timezone;
  const header = (
    <CardHeader>
      <CardTitle>Network access</CardTitle>
      <CardDescription>Billing status and network status are tracked separately.</CardDescription>
    </CardHeader>
  );
  if (!ctx.permissions.has("network.read")) {
    return (
      <Card>
        {header}
        <CardContent className="text-sm text-muted-foreground">You do not have permission to view network access.</CardContent>
      </Card>
    );
  }
  const pppoe = subscriptions.filter((s) => s.serviceType === "PPPOE" && s.status !== "CANCELLED");
  const states = await Promise.all(pppoe.map((s) => subscriptionNetwork(ctx, s.id)));
  const canOperate = ctx.permissions.has("network.operate");
  const routers = canOperate && ctx.permissions.has("routers.read") ? await routerOptions(ctx, "pppoe") : [];
  const adapter = networkAdapterName();

  return (
    <Card>
      {header}
      <CardContent className="space-y-4 text-sm">
        {adapter === "mock" ? <Alert tone="info">Mock network adapter: operations are simulated and no router is changed.</Alert> : null}
        {adapter === "disabled" ? <Alert tone="warning">Network automation is disabled for this deployment.</Alert> : null}
        {pppoe.length === 0 ? <p className="text-muted-foreground">No current PPPoE subscription. Hotspot customers connect with vouchers.</p> : null}
        {states.map((n, i) => {
          const last = n.operations[0];
          const session = n.sessions[0];
          return (
            <section key={n.subscriptionId} aria-label={`Network access for ${pppoe[i]!.packageName}`} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <RouterIcon className="size-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">{pppoe[i]!.packageName}</span>
                <NetworkStatusBadge status={n.networkStatus} />
              </div>
              {n.provisioned ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Router</dt>
                  <dd>
                    {n.router ? (
                      <Link href={`/routers/${n.router.id}`} className="text-accent hover:underline">
                        {n.router.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                    {n.router?.pppoeAuth === "RADIUS" ? " · via RADIUS" : ""}
                  </dd>
                  <dt className="text-muted-foreground">PPPoE username</dt>
                  <dd className="font-mono">{n.username}</dd>
                  <dt className="text-muted-foreground">Session</dt>
                  <dd>{session ? `${session.address ?? "Connected"} · up ${formatDuration(session.uptimeSeconds)}` : "None seen in the last sync"}</dd>
                </dl>
              ) : (
                <p className="text-muted-foreground">Not provisioned on any router.</p>
              )}
              {last ? (
                <p className="text-xs text-muted-foreground">
                  Last operation:{" "}
                  <Link href={`/sessions/operations/${last.id}`} className="text-accent hover:underline">
                    {last.label}
                  </Link>{" "}
                  <OperationStatusBadge status={last.status} /> · {formatDateTime(last.createdAt, tz)}
                  {last.resultDetail ? <span className="block">{last.resultDetail}</span> : null}
                </p>
              ) : null}
              {canOperate && pppoe[i]!.status !== "CANCELLED" ? (
                <NetworkActions
                  subscriptionId={n.subscriptionId}
                  packageName={pppoe[i]!.packageName}
                  provisioned={n.provisioned}
                  username={n.username}
                  currentRouterId={n.router?.id ?? null}
                  routers={routers.map((r) => ({ id: r.id, label: `${r.name} (${r.host}${r.pppoeAuth === "RADIUS" ? ", RADIUS" : ""})` }))}
                />
              ) : null}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
