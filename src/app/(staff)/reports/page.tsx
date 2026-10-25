import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { collectionsReport, receivablesAging, reportRangeQuery, revenueReport, subscriberReport } from "@/server/services/reports";
import { listExports } from "@/server/services/exports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { FilterTabs } from "@/components/list-toolbar";
import { BarSeriesChart } from "@/components/charts";
import { METHOD_LABEL, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { formatDateTime, formatMoney } from "@/lib/utils";
import { ExportButton } from "./export-button";

export const metadata: Metadata = { title: "Reports" };

const TABS = ["revenue", "receivables", "subscribers", "collections", "exports"] as const;
type Tab = (typeof TABS)[number];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("reports.read");
  if (!allowed) return <Forbidden what="reports" />;
  const sp = await searchParams;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "revenue";
  const range = reportRangeQuery.safeParse({ from: sp.from, to: sp.to });
  const q = range.success ? range.data : {};
  const canExport = ctx.permissions.has("reports.export");
  const cur = ctx.organization.currency;
  const m = (v: string) => formatMoney(v, cur);
  const link = (t: Tab) => `/reports?tab=${t}${sp.from ? `&from=${sp.from}` : ""}${sp.to ? `&to=${sp.to}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Figures come from the ledger and persisted records. Months follow the organization timezone." />
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterTabs label="Report" active={tab} items={TABS.filter((t) => t !== "exports" || canExport).map((t) => ({ value: t, label: humanize(t), href: link(t) }))} />
        {tab !== "exports" && tab !== "receivables" ? (
          <form method="get" action="/reports" className="flex flex-wrap items-end gap-2 text-sm">
            <input type="hidden" name="tab" value={tab} />
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">From</span>
              <Input type="month" name="from" defaultValue={sp.from} className="w-40" />
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">To</span>
              <Input type="month" name="to" defaultValue={sp.to} className="w-40" />
            </label>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </form>
        ) : null}
      </div>

      {tab === "revenue" ? await Revenue() : null}
      {tab === "receivables" ? await Receivables() : null}
      {tab === "subscribers" ? await Subscribers() : null}
      {tab === "collections" ? await Collections() : null}
      {tab === "exports" && canExport ? await Exports() : null}
    </div>
  );

  async function Revenue() {
    const r = await revenueReport(ctx, q);
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Net revenue" value={m(r.totals.netRevenue)} hint="Invoiced, less credit notes, excl. tax" />
          <Stat label="Collected" value={m(r.totals.collected)} hint="Receipts less refunds and reversals" />
          <Stat label="Expenses" value={m(r.totals.expenses)} hint="Operating expenses recorded" />
          <Stat label="Tax" value={m(r.totals.tax)} hint="Net tax on invoices" />
        </div>
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Net revenue and collections by month</CardTitle>
              <CardDescription>Revenue is recognised when an invoice is issued; collections when money is received.</CardDescription>
            </div>
            {canExport ? <ExportButton type="revenue" params={{ from: sp.from, to: sp.to }} /> : null}
          </CardHeader>
          <CardContent>
            <BarSeriesChart
              ariaLabel="Net revenue and collections by month"
              data={r.months}
              xKey="month"
              currency={cur}
              series={[
                { key: "netRevenue", label: "Net revenue", slot: 1 },
                { key: "collected", label: "Collected", slot: 2 },
              ]}
            />
          </CardContent>
          <Table>
            <THead>
              <tr>
                <Th>Month</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Credit notes</Th>
                <Th className="text-right">Net revenue</Th>
                <Th className="text-right">Tax</Th>
                <Th className="text-right">Collected</Th>
                <Th className="text-right">Expenses</Th>
              </tr>
            </THead>
            <TBody>
              {[...r.months].reverse().map((row) => (
                <Tr key={row.month}>
                  <Td label="Month">{row.month}</Td>
                  <Td label="Revenue" className="tabular md:text-right">{m(row.revenue)}</Td>
                  <Td label="Credit notes" className="tabular md:text-right">{m(row.creditNotes)}</Td>
                  <Td label="Net revenue" className="tabular font-medium md:text-right">{m(row.netRevenue)}</Td>
                  <Td label="Tax" className="tabular md:text-right">{m(row.tax)}</Td>
                  <Td label="Collected" className="tabular md:text-right">{m(row.collected)}</Td>
                  <Td label="Expenses" className="tabular md:text-right">{m(row.expenses)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    );
  }

  async function Receivables() {
    const r = await receivablesAging(ctx);
    const bucketLabel: Record<string, string> = { current: "Not yet due", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "Over 90 days" };
    const totals = r.totals as Record<string, string>;
    return (
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Receivables aging</CardTitle>
            <CardDescription>Open invoice balances by days past due. Total {m(totals.total!)} — equals accounts receivable in the ledger.</CardDescription>
          </div>
          {canExport ? <ExportButton type="receivables_aging" /> : null}
        </CardHeader>
        <CardContent>
          <BarSeriesChart ariaLabel="Receivables by age" data={r.buckets.map((b) => ({ month: bucketLabel[b]!, amount: totals[b]! }))} xKey="month" currency={cur} series={[{ key: "amount", label: "Outstanding", slot: 1 }]} height={220} />
        </CardContent>
        <Table>
          <THead>
            <tr>
              <Th>Subscriber</Th>
              {r.buckets.map((b) => (
                <Th key={b} className="text-right">
                  {bucketLabel[b]}
                </Th>
              ))}
              <Th className="text-right">Total</Th>
            </tr>
          </THead>
          <TBody>
            {r.rows.slice(0, 100).map((row) => (
              <Tr key={row.subscriberId}>
                <Td label="Subscriber">
                  <a href={`/subscribers/${row.subscriberId}`} className="hover:underline">
                    {row.name}
                  </a>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{row.accountNumber}</span>
                </Td>
                {r.buckets.map((b) => (
                  <Td key={b} label={bucketLabel[b]} className="tabular md:text-right">
                    {Number(row[b]) ? m(row[b]!) : "—"}
                  </Td>
                ))}
                <Td label="Total" className="tabular font-medium md:text-right">
                  {m(row.total!)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        {r.rows.length === 0 ? <CardContent className="text-sm text-muted-foreground">Nothing outstanding.</CardContent> : null}
      </Card>
    );
  }

  async function Subscribers() {
    const r = await subscriberReport(ctx, q);
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>New subscribers by month</CardTitle>
              <CardDescription>Accounts created; lifecycle events from the subscription history.</CardDescription>
            </div>
            {canExport ? <ExportButton type="subscribers" /> : null}
          </CardHeader>
          <CardContent>
            <BarSeriesChart ariaLabel="New subscribers by month" data={r.months} xKey="month" series={[{ key: "newSubscribers", label: "New subscribers", slot: 1 }]} height={220} />
          </CardContent>
          <Table>
            <THead>
              <tr>
                <Th>Month</Th>
                <Th className="text-right">New</Th>
                <Th className="text-right">Activated</Th>
                <Th className="text-right">Renewed</Th>
                <Th className="text-right">Suspended</Th>
                <Th className="text-right">Expired</Th>
                <Th className="text-right">Cancelled</Th>
              </tr>
            </THead>
            <TBody>
              {[...r.months].reverse().map((row) => (
                <Tr key={row.month}>
                  <Td label="Month">{row.month}</Td>
                  <Td label="New" className="tabular md:text-right">{row.newSubscribers}</Td>
                  <Td label="Activated" className="tabular md:text-right">{row.activated}</Td>
                  <Td label="Renewed" className="tabular md:text-right">{row.renewed}</Td>
                  <Td label="Suspended" className="tabular md:text-right">{row.suspended}</Td>
                  <Td label="Expired" className="tabular md:text-right">{row.expired}</Td>
                  <Td label="Cancelled" className="tabular md:text-right">{row.cancelled}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active subscriptions by package</CardTitle>
            <CardDescription>Monthly-equivalent recurring revenue, excl. tax</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {r.byPackage.length === 0 ? <p className="text-muted-foreground">No active subscriptions.</p> : null}
            {r.byPackage.map((p) => (
              <div key={p.packageName} className="flex items-center justify-between gap-3">
                <span>
                  {p.packageName} <span className="text-xs text-muted-foreground">· {p.active}</span>
                </span>
                <span className="tabular">{formatMoney(p.mrr, p.currency)}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {Object.entries(r.byStatus).map(([s, n]) => (
                <Badge key={s} tone="neutral">
                  {humanize(s)}: {n}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  async function Collections() {
    const r = await collectionsReport(ctx, q);
    const slots = [1, 2, 3, 4, 5, 6] as const;
    return (
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Collections by payment method</CardTitle>
            <CardDescription>Confirmed payments by month received (before refunds; reversed payments excluded).</CardDescription>
          </div>
          {canExport ? <ExportButton type="payments" params={{ from: sp.from, to: sp.to }} /> : null}
        </CardHeader>
        <CardContent>
          {r.methods.length ? (
            <BarSeriesChart ariaLabel="Collections by method and month" data={r.months} xKey="month" currency={cur} stacked series={r.methods.slice(0, 6).map((meth, i) => ({ key: meth, label: METHOD_LABEL[meth] ?? meth, slot: slots[i]! }))} />
          ) : (
            <p className="text-sm text-muted-foreground">No confirmed payments in this period.</p>
          )}
        </CardContent>
        <Table>
          <THead>
            <tr>
              <Th>Month</Th>
              {r.methods.map((meth) => (
                <Th key={meth} className="text-right">
                  {METHOD_LABEL[meth] ?? meth}
                </Th>
              ))}
              <Th className="text-right">Payments</Th>
              <Th className="text-right">Total</Th>
            </tr>
          </THead>
          <TBody>
            {[...r.months].reverse().map((row) => (
              <Tr key={row.month}>
                <Td label="Month">{row.month}</Td>
                {r.methods.map((meth) => (
                  <Td key={meth} label={METHOD_LABEL[meth] ?? meth} className="tabular md:text-right">
                    {m(String((row as Record<string, string | number>)[meth] ?? "0"))}
                  </Td>
                ))}
                <Td label="Payments" className="tabular md:text-right">{row.count}</Td>
                <Td label="Total" className="tabular font-medium md:text-right">{m(row.total)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Card>
    );
  }

  async function Exports() {
    const jobs = await listExports(ctx);
    const tz = ctx.organization.timezone;
    return (
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Exports</CardTitle>
            <CardDescription>CSV files are generated in the background and can be downloaded for 24 hours. Every request and download is recorded in the audit log.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <ExportButton type="invoices" />
            <ExportButton type="payments" />
            {ctx.permissions.has("audit.read") ? <ExportButton type="audit_logs" /> : null}
          </div>
        </CardHeader>
        {jobs.length === 0 ? (
          <CardContent className="text-sm text-muted-foreground">No exports yet.</CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Requested</Th>
                <Th>Export</Th>
                <Th>Status</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right">Download</Th>
              </tr>
            </THead>
            <TBody>
              {jobs.map((j) => (
                <Tr key={j.id}>
                  <Td label="Requested">{formatDateTime(j.createdAt, tz)}</Td>
                  <Td label="Export">{j.label}</Td>
                  <Td label="Status">
                    <Badge tone={j.status === "READY" ? "success" : j.status === "FAILED" ? "danger" : j.status === "EXPIRED" ? "neutral" : "info"}>{humanize(j.status)}</Badge>
                    {j.error ? <span className="block text-xs text-muted-foreground">{j.error}</span> : null}
                  </Td>
                  <Td label="Rows" className="tabular md:text-right">{j.rowCount ?? "—"}</Td>
                  <Td label="Download" className="md:text-right">
                    {j.downloadable ? (
                      <a href={`/api/v1/exports/${j.id}/download`} className="text-accent hover:underline">
                        Download CSV
                      </a>
                    ) : j.status === "QUEUED" || j.status === "RUNNING" ? (
                      <span className="text-xs text-muted-foreground">Generating… refresh shortly</span>
                    ) : (
                      "—"
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    );
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
