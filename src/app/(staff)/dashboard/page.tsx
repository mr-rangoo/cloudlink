import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CalendarClock, Database, FileText, Repeat, Server, TrendingUp, UserPlus, Users, Wallet } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { checkDatabase, workerStatus } from "@/server/observability/health";
import { pingRedis } from "@/server/jobs/redis";
import { dashboardActivity, dashboardSummary } from "@/server/services/dashboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

const statusTone: Record<string, Tone> = { ok: "success", unavailable: "danger", not_configured: "neutral" };

const STATUS_BAR: Array<{ key: "active" | "pending" | "suspended" | "expired"; label: string; className: string }> = [
  { key: "active", label: "Active", className: "bg-success" },
  { key: "pending", label: "Pending", className: "bg-info" },
  { key: "suspended", label: "Suspended", className: "bg-warning" },
  { key: "expired", label: "Expired", className: "bg-danger" },
];

export default async function DashboardPage() {
  const { ctx, allowed } = await getStaffContextWith("dashboard.view");
  if (!allowed) return <Forbidden what="the dashboard" />;

  const [summary, activity, database, redis, workers] = await Promise.all([dashboardSummary(ctx), dashboardActivity(ctx), checkDatabase(), pingRedis(), workerStatus()]);
  const healthyWorkers = workers.filter((w) => w.healthy).length;
  const tz = ctx.organization.timezone;
  const subs = summary.subscriptions;
  const liveTotal = subs ? subs.active + subs.pending + subs.suspended + subs.expired : 0;
  const mrr = summary.recurringRevenue?.find((r) => r.currency === ctx.organization.currency) ?? summary.recurringRevenue?.[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${ctx.userName.split(" ")[0]}`}
        description={`${ctx.organization.name} · ${ctx.organization.currency} · ${ctx.organization.timezone}${ctx.activeBranchId ? " · filtered to one branch" : ""}`}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={Users} label="Subscribers" value={summary.subscribers ? String(summary.subscribers.total) : null} hint={summary.subscribers ? `${summary.subscribers.newThisMonth} new this month` : undefined} href="/subscribers" />
        <Kpi icon={Repeat} label="Active subscriptions" value={subs ? String(subs.active) : null} hint={subs ? `${subs.suspended} suspended · ${subs.expired} expired` : undefined} href="/subscriptions?status=ACTIVE" />
        <Kpi
          icon={TrendingUp}
          label="Recurring revenue (monthly)"
          value={summary.recurringRevenue ? formatMoney(mrr?.monthly ?? "0", mrr?.currency ?? ctx.organization.currency) : null}
          hint="Active subscription prices, monthly equivalent, excl. tax"
        />
        <Kpi icon={CalendarClock} label="Expiring in 7 days" value={subs ? String(subs.expiringIn7Days) : null} hint="Active, paid period ends within 7 days" href="/subscriptions?expiring=7d" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={FileText} label="Receivables" value={summary.billing ? formatMoney(summary.billing.receivables, ctx.organization.currency) : null} hint={summary.billing ? `${summary.billing.openInvoices} open invoice(s)` : undefined} href="/invoices?status=UNPAID" />
        <Kpi icon={AlertTriangle} label="Overdue" value={summary.billing ? formatMoney(summary.billing.overdue, ctx.organization.currency) : null} hint={summary.billing ? `${summary.billing.overdueInvoices} invoice(s) past due` : undefined} href="/invoices?status=OVERDUE" />
        <Kpi icon={Wallet} label="Collected this month" value={summary.collections ? formatMoney(summary.collections.thisMonth, ctx.organization.currency) : null} hint={summary.collections ? `${summary.collections.payments} confirmed payment(s)` : undefined} href="/payments?status=CONFIRMED" />
        <Kpi icon={AlertTriangle} label="Payment exceptions" value={summary.collections ? String(summary.collections.unmatchedPayments) : null} hint="Confirmed payments not matched to a subscriber" href="/payments?unmatched=1" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Subscription status</CardTitle>
            <CardDescription>Billing status of all non-cancelled subscriptions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!subs ? (
              <p className="text-sm text-muted-foreground">You do not have permission to view subscriptions.</p>
            ) : liveTotal === 0 ? (
              <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
            ) : (
              <>
                <div className="flex h-3 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={STATUS_BAR.map((s) => `${s.label}: ${subs[s.key]}`).join(", ")}>
                  {STATUS_BAR.map((s) => (subs[s.key] ? <div key={s.key} className={s.className} style={{ width: `${(subs[s.key] / liveTotal) * 100}%` }} /> : null))}
                </div>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {STATUS_BAR.map((s) => (
                    <li key={s.key}>
                      <Link href={`/subscriptions?status=${s.key.toUpperCase()}`} className="block rounded-md border border-border px-3 py-2 hover:bg-surface-muted">
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className={`size-2 rounded-full ${s.className}`} aria-hidden />
                          {s.label}
                        </span>
                        <span className="tabular text-lg font-semibold">{subs[s.key]}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sales pipeline</CardTitle>
            <CardDescription>Leads in this scope</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {summary.leads ? (
              <>
                <Row label="Open leads" icon={UserPlus}>
                  <Link href="/leads" className="tabular font-semibold hover:underline">
                    {summary.leads.open}
                  </Link>
                </Row>
                <Row label="Converted this month" icon={TrendingUp}>
                  <span className="tabular font-semibold">{summary.leads.wonThisMonth}</span>
                </Row>
              </>
            ) : (
              <p className="text-muted-foreground">You do not have permission to view leads.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent subscriber activity</CardTitle>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {activity.map((a) => (
                  <li key={a.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <span className="min-w-0 text-sm">
                      <Link href={`/subscribers/${a.subscriber.id}`} className="font-medium hover:underline">
                        {a.subscriber.displayName}
                      </Link>{" "}
                      <span className="text-muted-foreground">— {a.message}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(a.createdAt, tz)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>System status</CardTitle>
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
              <CardTitle>Not yet available</CardTitle>
              <CardDescription>Shown once their modules are built — never estimated</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Support workload (phase 4); router status and network operations (phase 7).
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, hint, href }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | null; hint?: string; href?: string }) {
  const body = (
    <CardContent className="flex items-start gap-4 py-5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <Icon className="size-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="tabular truncate text-2xl font-semibold tracking-tight">{value ?? "—"}</p>
        <p className="truncate text-xs text-muted-foreground">{value === null ? "No permission to view" : hint}</p>
      </div>
    </CardContent>
  );
  return <Card className={href ? "transition-colors hover:border-border-strong" : undefined}>{href && value !== null ? <Link href={href}>{body}</Link> : body}</Card>;
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
