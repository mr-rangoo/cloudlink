import type { Metadata } from "next";
import Link from "next/link";
import { Activity, AlertTriangle, Bell, CalendarClock, Database, FileText, LifeBuoy, ListChecks, Router as RouterIcon, Server, TrendingUp, UserPlus, Wallet } from "lucide-react";
import { networkAdapterName } from "@/server/integrations/network";
import { getStaffContextWith } from "@/server/auth/page";
import { checkDatabase, workerStatus } from "@/server/observability/health";
import { pingRedis } from "@/server/jobs/redis";
import { toWallTime } from "@/server/domain/time";
import { dashboardActivity, dashboardPulse, dashboardSummary } from "@/server/services/dashboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { StatStrip, type StripStat } from "@/components/stat-strip";
import { BarSeriesChart } from "@/components/charts";
import { AutoRefresh, LiveDot } from "@/components/live";
import { RouterStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

const statusTone: Record<string, Tone> = { ok: "success", unavailable: "danger", not_configured: "neutral" };

const STATUS_BAR: Array<{ key: "active" | "pending" | "suspended" | "expired"; label: string; className: string }> = [
  { key: "active", label: "Active", className: "bg-success" },
  { key: "pending", label: "Pending", className: "bg-info" },
  { key: "suspended", label: "Suspended", className: "bg-warning" },
  { key: "expired", label: "Expired", className: "bg-danger" },
];

const METHOD: Record<string, string> = { MPESA: "M-Pesa", CASH: "Cash", BANK_TRANSFER: "Bank transfer", CHEQUE: "Cheque", CARD: "Card", OTHER: "Other" };

function greeting(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** "Up 12% on yesterday by now" (same time of day) — plain words, no colour needed. */
function comparison(today: string, before: string): string {
  const t = Number(today);
  const b = Number(before);
  if (b === 0) return "None by this time yesterday";
  const pct = Math.round(((t - b) / b) * 100);
  if (pct === 0) return "Same as yesterday by now";
  return `${pct > 0 ? "Up" : "Down"} ${Math.abs(pct)}% on yesterday by now`;
}

export default async function DashboardPage() {
  const { ctx, allowed } = await getStaffContextWith("dashboard.view");
  if (!allowed) return <Forbidden what="the dashboard" />;

  const [summary, pulse, activity, database, redis, workers] = await Promise.all([dashboardSummary(ctx), dashboardPulse(ctx), dashboardActivity(ctx, 10), checkDatabase(), pingRedis(), workerStatus()]);
  const healthyWorkers = workers.filter((w) => w.healthy).length;
  const tz = ctx.organization.timezone;
  const currency = ctx.organization.currency;
  const subs = summary.subscriptions;
  const liveTotal = subs ? subs.active + subs.pending + subs.suspended + subs.expired : 0;
  const mrr = summary.recurringRevenue?.find((r) => r.currency === currency) ?? summary.recurringRevenue?.[0];
  const now = new Date();
  const local = toWallTime(now, tz);
  const dateLine = new Intl.DateTimeFormat("en-KE", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(now);
  const health = pulse.subscriberHealth;

  const stats: StripStat[] = [];
  if (pulse.collections) {
    stats.push({ label: "Collected today", value: formatMoney(pulse.collections.today, currency), hint: comparison(pulse.collections.today, pulse.collections.yesterdayByNow), href: "/payments?status=CONFIRMED" });
  }
  if (health) stats.push({ label: "Online now", value: health.online, hint: `of ${health.provisioned} with network access`, href: "/sessions", tone: "success" });
  if (subs) {
    stats.push({ label: "Active subscriptions", value: subs.active, hint: `${subs.suspended} suspended · ${subs.expired} expired`, href: "/subscriptions?status=ACTIVE" });
    stats.push({ label: "Expiring in 24 h", value: pulse.expiring?.count ?? 0, hint: `${subs.expiringIn7Days} within 7 days`, href: "/subscriptions?expiring=24h" });
  }
  if (summary.billing) stats.push({ label: "Receivables", value: formatMoney(summary.billing.receivables, currency), hint: `${formatMoney(summary.billing.overdue, currency)} overdue`, href: "/invoices?status=UNPAID", tone: Number(summary.billing.overdue) > 0 ? "danger" : "default" });
  if (summary.recurringRevenue) stats.push({ label: "Recurring revenue", value: formatMoney(mrr?.monthly ?? "0", mrr?.currency ?? currency), hint: "Monthly equivalent, excl. tax" });

  // One feed: payments received and subscriber activity, newest first.
  const feed = [
    ...(pulse.recentPayments ?? []).map((p) => ({
      key: `p-${p.id}`,
      at: p.receivedAt ?? new Date(0),
      icon: Wallet,
      text: (
        <>
          <span className="font-medium">{formatMoney(p.amount, p.currency)}</span> {METHOD[p.method] ?? p.method}
          {p.subscriber ? (
            <>
              {" from "}
              <Link href={`/subscribers/${p.subscriber.id}`} className="hover:underline">
                {p.subscriber.displayName}
              </Link>
            </>
          ) : (
            <span className="text-muted-foreground"> (not matched yet)</span>
          )}
          {p.receiptNumber ? <span className="text-muted-foreground"> · {p.receiptNumber}</span> : null}
        </>
      ),
    })),
    ...activity.map((a) => ({
      key: `a-${a.id}`,
      at: a.createdAt,
      icon: Activity,
      text: (
        <>
          <Link href={`/subscribers/${a.subscriber.id}`} className="font-medium hover:underline">
            {a.subscriber.displayName}
          </Link>{" "}
          <span className="text-muted-foreground">{a.message}</span>
        </>
      ),
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 12);

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={60} />
      <PageHeader
        title={`${greeting(local.hour)}, ${ctx.userName.split(" ")[0]}`}
        description={`${dateLine} · ${ctx.organization.name}${ctx.activeBranchId ? " · one branch" : ""}`}
        actions={
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <LiveDot live /> Refreshes every minute
          </span>
        }
      />

      {stats.length ? <StatStrip stats={stats} /> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {pulse.collections ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Collections, last 14 days</CardTitle>
              <CardDescription>
                Confirmed payments in {pulse.collections.currency} per day. Yesterday {formatMoney(pulse.collections.yesterday, currency)}; today so far {formatMoney(pulse.collections.today, currency)} from {pulse.collections.todayPayments} payment
                {pulse.collections.todayPayments === 1 ? "" : "s"}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BarSeriesChart
                data={pulse.collections.days.map((d) => ({ day: new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-KE", { day: "numeric", month: "short", timeZone: "UTC" }), amount: d.amount }))}
                xKey="day"
                series={[{ key: "amount", label: "Collected", slot: 1 }]}
                currency={currency}
                height={220}
                ariaLabel="Collections per day for the last 14 days"
              />
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-xs text-accent">Data table</summary>
                <table className="mt-2 w-full text-xs">
                  <tbody className="divide-y divide-border">
                    {pulse.collections.days.map((d) => (
                      <tr key={d.day}>
                        <td className="py-1">{d.day}</td>
                        <td className="tabular py-1 text-right">{d.payments} payments</td>
                        <td className="tabular py-1 text-right">{formatMoney(d.amount, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </CardContent>
          </Card>
        ) : null}

        <Card className={pulse.collections ? undefined : "lg:col-span-3"}>
          <CardHeader>
            <CardTitle>What&apos;s next</CardTitle>
            <CardDescription>Things that need attention soon.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {pulse.expiring ? (
              <div>
                <p className="mb-1.5 flex items-center justify-between gap-2 font-medium">
                  <span className="flex items-center gap-2">
                    <CalendarClock className="size-4 text-muted-foreground" aria-hidden /> Expiring in 24 hours
                  </span>
                  <Link href="/subscriptions?expiring=24h" className="tabular text-accent hover:underline">
                    {pulse.expiring.count}
                  </Link>
                </p>
                {pulse.expiring.rows.length ? (
                  <ul className="space-y-1 text-xs">
                    {pulse.expiring.rows.map((s) => (
                      <li key={s.id} className="flex justify-between gap-3">
                        <Link href={`/subscribers/${s.subscriber.id}`} className="min-w-0 truncate hover:underline">
                          {s.subscriber.displayName} <span className="text-muted-foreground">· {s.packageName}</span>
                        </Link>
                        <span className="shrink-0 text-muted-foreground">{s.currentPeriodEnd ? new Intl.DateTimeFormat("en-KE", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(s.currentPeriodEnd) : ""}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">Nothing expires in the next 24 hours.</p>
                )}
              </div>
            ) : null}
            <ul className="space-y-2.5 border-t border-border pt-3">
              {pulse.renewalsDue ? (
                <NextRow icon={FileText} label="Invoices due in 3 days" href="/invoices?status=UNPAID" value={`${pulse.renewalsDue.count} · ${formatMoney(pulse.renewalsDue.amount, currency)}`} />
              ) : null}
              {summary.collections ? <NextRow icon={Wallet} label="Payments to match" href="/reconciliation" value={summary.collections.unmatchedPayments} danger={summary.collections.unmatchedPayments > 0} /> : null}
              {summary.network?.operations ? <NextRow icon={ListChecks} label="Failed network operations (7 days)" href="/sessions?tab=operations&status=FAILED" value={summary.network.operations.failed7d} danger={summary.network.operations.failed7d > 0} /> : null}
              {summary.network?.openAlerts != null ? <NextRow icon={Bell} label="Open network alerts" href="/sessions?tab=alerts" value={summary.network.openAlerts} danger={summary.network.openAlerts > 0} /> : null}
              {summary.support ? <NextRow icon={LifeBuoy} label="Urgent tickets without an owner" href="/support?assignee=unassigned" value={summary.support.urgentUnassigned} danger={summary.support.urgentUnassigned > 0} /> : null}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Subscriber health</CardTitle>
            <CardDescription>Active subscriptions with network access, by whether they are connected now.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {health ? (
              <>
                <Meter parts={[{ label: "Online", value: health.online, className: "bg-success" }, { label: "Offline", value: Math.max(0, health.provisioned - health.online), className: "bg-border-strong" }]} />
                <ul className="space-y-2.5">
                  <NextRow icon={Activity} label="Online now" href="/sessions" value={health.online} />
                  <NextRow icon={RouterIcon} label="Active but offline" href="/subscribers?connection=offline" value={Math.max(0, health.provisioned - health.online)} />
                  <NextRow icon={AlertTriangle} label="Expired in 7 days, not renewed" href="/subscriptions?status=EXPIRED" value={health.expired7d} />
                </ul>
                {networkAdapterName() === "mock" ? <p className="text-xs text-muted-foreground">Mock adapter: sessions are simulated.</p> : null}
              </>
            ) : (
              <p className="text-muted-foreground">Needs permission to view subscriptions and network sessions.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Busiest routers</CardTitle>
            <CardDescription>Most open sessions now, with the 24-hour health score.</CardDescription>
          </CardHeader>
          {pulse.busiestRouters === null ? (
            <CardContent className="text-sm text-muted-foreground">Needs permission to view routers and network sessions.</CardContent>
          ) : pulse.busiestRouters.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">No routers registered.</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {pulse.busiestRouters.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={`/routers/${r.id}`} className="truncate font-medium hover:underline">
                      {r.name}
                    </Link>
                    <RouterStatusBadge status={r.status} adapter={networkAdapterName()} />
                    {r.maintenanceMode ? <Badge tone="warning">Maintenance</Badge> : null}
                  </span>
                  <span className="flex items-center gap-3">
                    {r.health.score !== null ? (
                      <Badge tone={r.health.grade === "good" ? "success" : r.health.grade === "fair" ? "warning" : "danger"}>
                        Health {r.health.score}
                      </Badge>
                    ) : null}
                    <span className="tabular w-24 text-right">
                      {r.sessions} session{r.sessions === 1 ? "" : "s"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Latest activity</CardTitle>
            <CardDescription>Payments received and subscriber events, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {feed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {feed.map((f) => {
                  const Icon = f.icon;
                  return (
                    <li key={f.key} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <span className="flex min-w-0 items-start gap-2 text-sm">
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0">{f.text}</span>
                      </span>
                      <span className="shrink-0 pl-6 text-xs text-muted-foreground sm:pl-0">{formatDateTime(f.at, tz)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Subscriptions</CardTitle>
              <CardDescription>Billing status of all non-cancelled subscriptions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!subs ? (
                <p className="text-sm text-muted-foreground">You do not have permission to view subscriptions.</p>
              ) : liveTotal === 0 ? (
                <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
              ) : (
                <>
                  <Meter parts={STATUS_BAR.map((s) => ({ label: s.label, value: subs[s.key], className: s.className }))} />
                  <ul className="grid grid-cols-2 gap-2">
                    {STATUS_BAR.map((s) => (
                      <li key={s.key}>
                        <Link href={`/subscriptions?status=${s.key.toUpperCase()}`} className="block rounded-md border border-border px-3 py-1.5 hover:bg-surface-muted">
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className={`size-2 rounded-full ${s.className}`} aria-hidden />
                            {s.label}
                          </span>
                          <span className="tabular font-semibold">{subs[s.key]}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {summary.leads ? (
                <div className="space-y-2 border-t border-border pt-3 text-sm">
                  <Row label="Open leads" icon={UserPlus}>
                    <Link href="/leads" className="tabular font-semibold hover:underline">
                      {summary.leads.open}
                    </Link>
                  </Row>
                  <Row label="Leads converted this month" icon={TrendingUp}>
                    <span className="tabular font-semibold">{summary.leads.wonThisMonth}</span>
                  </Row>
                </div>
              ) : null}
            </CardContent>
          </Card>
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
              {summary.network?.routers ? (
                <Row label="Routers online" icon={RouterIcon}>
                  <Link href="/routers" className="tabular font-semibold hover:underline">
                    {summary.network.routers.online} of {summary.network.routers.total}
                  </Link>
                </Row>
              ) : null}
              {summary.support ? (
                <Row label="Open tickets" icon={LifeBuoy}>
                  <Link href="/support" className="tabular font-semibold hover:underline">
                    {summary.support.openTickets}
                  </Link>
                </Row>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Proportion bar with a labelled legend underneath (never colour alone). */
function Meter({ parts }: { parts: Array<{ label: string; value: number; className: string }> }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return null;
  return (
    <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}>
      {parts.map((p) => (p.value ? <div key={p.label} className={p.className} style={{ width: `${(p.value / total) * 100}%` }} /> : null))}
    </div>
  );
}

function NextRow({ icon: Icon, label, href, value, danger }: { icon: React.ComponentType<{ className?: string }>; label: string; href: string; value: React.ReactNode; danger?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </span>
      <Link href={href} className={`tabular font-semibold hover:underline ${danger ? "text-danger" : ""}`}>
        {value}
      </Link>
    </li>
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
