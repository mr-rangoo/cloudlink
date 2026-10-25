import type { Metadata } from "next";
import { Building2, Database, Server, ShieldCheck, Users } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { db } from "@/server/db/client";
import { checkDatabase, workerStatus } from "@/server/observability/health";
import { pingRedis } from "@/server/jobs/redis";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { NAV_ITEMS } from "@/lib/navigation";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

const statusTone: Record<string, Tone> = { ok: "success", unavailable: "danger", not_configured: "neutral", mock: "warning" };

function integrationModes() {
  return [
    { name: "Payments (M-Pesa)", mode: process.env.PAYMENT_ADAPTER ?? "mock" },
    { name: "Network (RouterOS)", mode: process.env.NETWORK_ADAPTER ?? "mock" },
    { name: "Messaging", mode: process.env.MESSAGING_ADAPTER ?? "mock" },
  ];
}

export default async function DashboardPage() {
  const { ctx, allowed } = await getStaffContextWith("dashboard.view");
  if (!allowed) return <Forbidden what="the dashboard" />;

  const [branchCount, staffCount, database, redis, workers, recentAudit] = await Promise.all([
    db.branch.count({ where: { organizationId: ctx.organizationId, status: { not: "ARCHIVED" } } }),
    db.membership.count({ where: { organizationId: ctx.organizationId, status: "ACTIVE" } }),
    checkDatabase(),
    pingRedis(),
    workerStatus(),
    db.auditLog.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, action: true, actorType: true, createdAt: true },
    }),
  ]);
  const healthyWorkers = workers.filter((w) => w.healthy).length;
  const available = NAV_ITEMS.filter((i) => i.available).length;

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${ctx.userName.split(" ")[0]}`} description={`${ctx.organization.name} · ${ctx.organization.currency} · ${ctx.organization.timezone}`} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Building2} label="Active branches" value={String(branchCount)} hint="Branches not archived" />
        <Stat icon={Users} label="Active staff" value={String(staffCount)} hint="Active memberships in this organization" />
        <Stat icon={ShieldCheck} label="Your permissions" value={String(ctx.permissions.size)} hint={ctx.roles.join(", ") || "No roles"} />
        <Stat icon={Server} label="Workers online" value={String(healthyWorkers)} hint={healthyWorkers ? "Heartbeat within the last minute" : "No recent worker heartbeat"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>System status</CardTitle>
            <CardDescription>Live checks from this server</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Database" icon={Database}>
              <Badge tone={statusTone[database] ?? "neutral"}>{database}</Badge>
            </Row>
            <Row label="Redis / queue" icon={Server}>
              <Badge tone={statusTone[redis] ?? "neutral"}>{redis.replace("_", " ")}</Badge>
            </Row>
            <Row label="Background worker" icon={Server}>
              <Badge tone={healthyWorkers ? "success" : "warning"}>{healthyWorkers ? `${healthyWorkers} online` : "offline"}</Badge>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Integration modes</CardTitle>
            <CardDescription>Mock adapters never move real money or change real devices</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {integrationModes().map((i) => (
              <Row key={i.name} label={i.name}>
                <Badge tone={i.mode === "mock" ? "warning" : i.mode === "disabled" ? "neutral" : "info"}>{i.mode === "mock" ? "mock (simulated)" : i.mode}</Badge>
              </Row>
            ))}
            <p className="text-xs text-muted-foreground">Live provider status is verified per organization once integrations are configured.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>From the audit log</CardDescription>
          </CardHeader>
          <CardContent>
            {recentAudit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {recentAudit.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs">{a.action}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(a.createdAt, ctx.organization.timezone)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Module rollout</CardTitle>
          <CardDescription>
            {available} of {NAV_ITEMS.length} modules available. Business KPIs (subscribers, receivables, collections) appear here as their modules ship.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {NAV_ITEMS.map((i) => (
            <Badge key={i.slug} tone={i.available ? "success" : "neutral"}>
              {i.label}
              {i.available ? "" : ` · phase ${i.phase}`}
            </Badge>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 py-5">
        <div className="flex size-10 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="tabular text-2xl font-semibold tracking-tight">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, icon: Icon, children }: { label: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        {Icon ? <Icon className="size-4" /> : null}
        {label}
      </span>
      {children}
    </div>
  );
}
