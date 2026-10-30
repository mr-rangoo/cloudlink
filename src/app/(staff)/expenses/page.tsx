import type { Metadata } from "next";
import Link from "next/link";
import { Receipt } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { expenseListQuery, expenseSummary, listExpenseCategories, listExpenses } from "@/server/services/finance";
import { PERIOD_LABEL } from "@/server/domain/periods";
import { listAccessibleBranches } from "@/server/auth/service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { PeriodFilter } from "@/components/period-filter";
import { StatStrip, type StripStat } from "@/components/stat-strip";
import { METHOD_LABEL } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatMoney } from "@/lib/utils";
import { ExpenseDialog, ReverseExpenseButton } from "./client";
import { ExportButton } from "../reports/export-button";

export const metadata: Metadata = { title: "Expenses" };

const KEYS = ["q", "status", "method", "categoryId", "period", "from", "to"] as const;

function change(now: string, before: string): string {
  const n = Number(now);
  const b = Number(before);
  if (b === 0) return n === 0 ? "Nothing in the period before either" : "Nothing in the period before";
  const pct = Math.round(((n - b) / b) * 100);
  return pct === 0 ? "Same as the period before" : `${pct > 0 ? "Up" : "Down"} ${Math.abs(pct)}% on the period before`;
}

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("expenses.read");
  if (!allowed) return <Forbidden what="expenses" />;
  // Filter forms submit "Any" as an empty value: drop those so they do not invalidate the rest.
  const sp = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => v)) as Record<string, string | undefined>;
  const parsed = expenseListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : expenseListQuery.parse({});
  const canWrite = ctx.permissions.has("expenses.write");
  const [{ rows, total, period }, summary, categories, branches] = await Promise.all([
    listExpenses(ctx, query),
    expenseSummary(ctx, query),
    listExpenseCategories(ctx),
    canWrite ? listAccessibleBranches(ctx) : Promise.resolve([]),
  ]);
  const tz = ctx.organization.timezone;
  const currency = summary.currency;
  const current = Object.fromEntries(KEYS.map((k) => [k, sp[k]]));
  const href = (patch: Record<string, string | undefined>) => buildHref("/expenses", current, { ...patch, page: undefined });
  const periodText = period ? `${formatDate(period.start, tz)} – ${formatDate(new Date(period.end.getTime() - 1), tz)}` : PERIOD_LABEL.all;
  const top = summary.byCategory[0];
  const largest = Math.max(1, ...summary.byCategory.map((c) => Number(c.amount)));

  const stats: StripStat[] = [
    { label: "Spent", value: formatMoney(summary.spent, currency), hint: summary.previous ? change(summary.spent, summary.previous.spent) : periodText },
    { label: "Entries", value: summary.entries, hint: periodText },
    { label: "Largest category", value: top ? top.name : "—", hint: top ? formatMoney(top.amount, currency) : undefined },
  ];
  if (summary.collected !== null && summary.net !== null) {
    stats.push({ label: "Collected", value: formatMoney(summary.collected, currency), hint: "Confirmed payments, same period" });
    stats.push({ label: "Collected minus spent", value: formatMoney(summary.net, currency), tone: Number(summary.net) < 0 ? "danger" : "success", hint: "Cash view, before tax" });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operating expenses"
        description="Operating costs paid from cash, bank or M-Pesa. Each expense posts to the ledger; corrections are reversals."
        actions={
          <>
            {ctx.permissions.has("reports.export") ? <ExportButton type="expenses" params={{ from: period?.fromDate, to: period?.toDate, method: query.method, categoryId: query.categoryId }} /> : null}
            {canWrite ? <ExpenseDialog currency={ctx.organization.currency} categories={categories.map((c) => ({ id: c.id, name: c.name }))} branches={branches} /> : null}
          </>
        }
      />
      <PeriodFilter action="/expenses" current={current} period={query.period} from={sp.from} to={sp.to} />
      <StatStrip stats={stats} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>By category</CardTitle>
            <CardDescription>Recorded expenses in this period (reversals excluded).</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.byCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses in this period.</p>
            ) : (
              <ul className="space-y-3" aria-label="Spending by category">
                {summary.byCategory.map((c) => (
                  <li key={c.categoryId} className="text-sm">
                    <div className="flex justify-between gap-3">
                      <Link href={href({ categoryId: c.categoryId })} className="truncate hover:underline">
                        {c.name}
                      </Link>
                      <span className="tabular shrink-0">
                        {formatMoney(c.amount, currency)}
                        <span className="text-muted-foreground"> · {Math.round((Number(c.amount) / Math.max(1, Number(summary.spent))) * 100)}%</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-surface-muted" aria-hidden>
                      <div className="h-full rounded-full" style={{ width: `${(Number(c.amount) / largest) * 100}%`, background: "var(--series-1)" }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <FilterTabs
                label="Expense status"
                active={query.status}
                items={[
                  { value: "ALL", label: "All", href: href({ status: undefined }) },
                  { value: "RECORDED", label: "Recorded", href: href({ status: "RECORDED" }) },
                  { value: "REVERSED", label: "Reversed", href: href({ status: "REVERSED" }) },
                ]}
              />
              <SearchForm action="/expenses" q={sp.q} placeholder="Description, payee or reference" hidden={{ ...current, q: undefined }} />
            </div>
            <form action="/expenses" className="flex flex-wrap items-end gap-2" aria-label="More filters">
              {(["q", "status", "period", "from", "to"] as const).map((k) => (sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null))}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Category
                <Select name="categoryId" defaultValue={sp.categoryId ?? ""} className="h-9 min-w-40">
                  <option value="">Any</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Paid via
                <Select name="method" defaultValue={sp.method ?? ""} className="h-9 min-w-36">
                  <option value="">Any</option>
                  {Object.entries(METHOD_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" variant="secondary" size="sm" className="h-9">
                Apply
              </Button>
              {sp.categoryId || sp.method ? (
                <Link href={href({ categoryId: undefined, method: undefined })} className="h-9 px-2 text-sm leading-9 text-accent hover:underline">
                  Clear
                </Link>
              ) : null}
            </form>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={Receipt} title={Object.values(current).some(Boolean) ? "No expenses match" : "No expenses recorded"} />
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Category</Th>
                    <Th>Description</Th>
                    <Th>Paid via</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Status</Th>
                    {canWrite ? <Th className="text-right">Actions</Th> : null}
                  </tr>
                </THead>
                <TBody>
                  {rows.map((e) => (
                    <Tr key={e.id}>
                      <Td label="Date" className="whitespace-nowrap">
                        {formatDate(e.paidAt, tz)}
                      </Td>
                      <Td label="Category">{e.categoryName}</Td>
                      <Td label="Description">
                        {e.description}
                        {e.payee ? <span className="block text-xs text-muted-foreground">{e.payee}</span> : null}
                      </Td>
                      <Td label="Paid via">
                        {METHOD_LABEL[e.method]} {e.reference ? <span className="font-mono text-xs text-muted-foreground">{e.reference}</span> : null}
                      </Td>
                      <Td label="Amount" className={`tabular md:text-right ${e.status === "REVERSED" ? "text-muted-foreground line-through" : ""}`}>
                        {formatMoney(e.amount.toString(), e.currency)}
                      </Td>
                      <Td label="Status">{e.status === "REVERSED" ? <Badge tone="neutral">Reversed</Badge> : <Badge tone="success">Recorded</Badge>}</Td>
                      {canWrite ? (
                        <Td label="Actions" className="md:text-right">
                          {e.status === "RECORDED" ? <ReverseExpenseButton id={e.id} /> : null}
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </TBody>
              </Table>
              <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/expenses", current, { page: p })} />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
