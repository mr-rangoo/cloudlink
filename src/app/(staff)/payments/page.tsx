import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Wallet } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listPayments, PAYMENT_TYPE_LABEL, paymentListQuery, paymentPeriodSummary, type PaymentType } from "@/server/services/payments";
import { PERIOD_LABEL } from "@/server/domain/periods";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { PeriodFilter } from "@/components/period-filter";
import { StatStrip, type StripStat } from "@/components/stat-strip";
import { METHOD_LABEL, PaymentStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";
import { ExportButton } from "../reports/export-button";

export const metadata: Metadata = { title: "Payments" };

const KEYS = ["q", "status", "method", "unmatched", "type", "period", "from", "to"] as const;

const RECONCILED: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "info" }> = {
  allocated: { label: "Allocated", tone: "success" },
  partly_allocated: { label: "Partly allocated", tone: "info" },
  credit: { label: "Credit on account", tone: "neutral" },
  unmatched: { label: "Unmatched", tone: "warning" },
};

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("payments.read");
  if (!allowed) return <Forbidden what="payments" />;
  // Filter forms submit "Any" as an empty value: drop those so they do not invalidate the rest.
  const sp = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => v)) as Record<string, string | undefined>;
  const parsed = paymentListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : paymentListQuery.parse({});
  const [{ rows, total, period }, summary] = await Promise.all([listPayments(ctx, query), paymentPeriodSummary(ctx, query)]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = Object.fromEntries(KEYS.map((k) => [k, sp[k]]));
  const tz = ctx.organization.timezone;
  const currency = summary.currency;
  const active = query.unmatched ? "UNMATCHED" : query.status;
  const href = (patch: Record<string, string | undefined>) => buildHref("/payments", current, { ...patch, page: undefined });
  const periodText = period ? (period.fromDate === period.toDate ? formatDate(period.start, tz) : `${formatDate(period.start, tz)} – ${formatDate(new Date(period.end.getTime() - 1), tz)}`) : PERIOD_LABEL.all;
  const method = (m: string) => summary.byMethod.find((x) => x.method === m);

  const stats: StripStat[] = [
    { label: "Collected", value: formatMoney(summary.collected, currency), hint: `${summary.payments} confirmed payments`, tone: "success" },
    { label: "M-Pesa", value: formatMoney(method("MPESA")?.amount ?? "0", currency), hint: `${method("MPESA")?.payments ?? 0} payments`, href: href({ method: "MPESA" }) },
    { label: "Cash", value: formatMoney(method("CASH")?.amount ?? "0", currency), hint: `${method("CASH")?.payments ?? 0} payments`, href: href({ method: "CASH" }) },
    { label: "Bank", value: formatMoney(method("BANK_TRANSFER")?.amount ?? "0", currency), hint: `${method("BANK_TRANSFER")?.payments ?? 0} payments`, href: href({ method: "BANK_TRANSFER" }) },
    { label: "Unmatched", value: formatMoney(summary.unmatched.amount, currency), hint: `${summary.unmatched.payments} to match`, tone: summary.unmatched.payments ? "danger" : "default", href: href({ unmatched: "1", status: undefined }) },
    { label: "Credit on accounts", value: formatMoney(summary.creditOnAccounts, currency), hint: "Not yet used by invoices" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments ledger"
        description={`Showing ${periodText}. Payments are confirmed by staff entry or provider callbacks, never by a browser redirect.`}
        actions={
          <>
            {ctx.permissions.has("reports.export") ? <ExportButton type="payments" params={{ from: period?.fromDate, to: period?.toDate, status: query.status === "ALL" ? undefined : query.status, method: query.method, type: query.type }} /> : null}
            <Link href="/payments/requests" className={buttonVariants({ variant: "secondary" })}>
              M-Pesa requests
            </Link>
            {ctx.permissions.has("payments.record") ? (
              <Link href="/payments/new" className={buttonVariants()}>
                <Plus /> Record payment
              </Link>
            ) : null}
          </>
        }
      />
      <PeriodFilter action="/payments" current={current} period={query.period} from={sp.from} to={sp.to} />
      <StatStrip stats={stats} />
      {summary.bySource.length ? (
        <p className="text-xs text-muted-foreground">
          By how the money arrived:{" "}
          {summary.bySource.map((s, i) => (
            <span key={s.source}>
              {i ? " · " : ""}
              <Link href={href({ type: s.source })} className="hover:underline">
                {PAYMENT_TYPE_LABEL[s.source]} {formatMoney(s.amount, currency)} ({s.payments})
              </Link>
            </span>
          ))}
          {summary.reversed.payments ? ` · Reversed ${formatMoney(summary.reversed.amount, currency)} (${summary.reversed.payments})` : ""}
        </p>
      ) : null}
      <Card>
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <FilterTabs
              label="Payment filter"
              active={active}
              items={[
                { value: "ALL", label: "All", href: href({ status: undefined, unmatched: undefined }) },
                { value: "CONFIRMED", label: "Confirmed", href: href({ status: "CONFIRMED", unmatched: undefined }) },
                { value: "UNMATCHED", label: "Unmatched", href: href({ status: undefined, unmatched: "1" }) },
                { value: "PENDING", label: "Pending", href: href({ status: "PENDING", unmatched: undefined }) },
                { value: "REVERSED", label: "Reversed", href: href({ status: "REVERSED", unmatched: undefined }) },
                { value: "FAILED", label: "Failed", href: href({ status: "FAILED", unmatched: undefined }) },
              ]}
            />
            <SearchForm action="/payments" q={sp.q} placeholder="Receipt, reference or payer" hidden={{ ...current, q: undefined }} />
          </div>
          <form action="/payments" className="flex flex-wrap items-end gap-2" aria-label="More filters">
            {(["q", "status", "unmatched", "period", "from", "to"] as const).map((k) => (sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null))}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Method
              <Select name="method" defaultValue={sp.method ?? ""} className="h-9 min-w-36">
                <option value="">Any</option>
                {Object.entries(METHOD_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Arrived as
              <Select name="type" defaultValue={sp.type ?? ""} className="h-9 min-w-40">
                <option value="">Any</option>
                {(Object.entries(PAYMENT_TYPE_LABEL) as Array<[PaymentType, string]>).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" variant="secondary" size="sm" className="h-9">
              Apply
            </Button>
            {sp.method || sp.type ? (
              <Link href={href({ method: undefined, type: undefined })} className="h-9 px-2 text-sm leading-9 text-accent hover:underline">
                Clear
              </Link>
            ) : null}
          </form>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={Wallet} title="No payments match" description="Record cash and bank payments here; M-Pesa payments arrive automatically once the integration is configured." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Receipt</Th>
                  <Th>Received</Th>
                  <Th>Subscriber</Th>
                  <Th>Type</Th>
                  <Th>Method</Th>
                  <Th>Status</Th>
                  <Th>Reconciled</Th>
                  <Th>Activation</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((p) => {
                  const rec = p.reconciliation ? RECONCILED[p.reconciliation] : null;
                  return (
                    <Tr key={p.id}>
                      <Td label="Receipt" className="font-mono text-xs">
                        <Link href={`/payments/${p.id}`} className="text-accent hover:underline">
                          {p.receiptNumber ?? "—"}
                        </Link>
                      </Td>
                      <Td label="Received" className="whitespace-nowrap">
                        {formatDateTime(p.receivedAt, tz)}
                      </Td>
                      <Td label="Subscriber">
                        {p.subscriber ? (
                          <Link href={`/subscribers/${p.subscriber.id}`} className="hover:underline">
                            {p.subscriber.displayName}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{p.payerName ?? "Unknown payer"}</span>
                        )}
                      </Td>
                      <Td label="Type" className="text-sm">
                        {PAYMENT_TYPE_LABEL[p.source as PaymentType] ?? p.source}
                      </Td>
                      <Td label="Method">
                        {METHOD_LABEL[p.method]}
                        {p.providerTransactionId ? <span className="block font-mono text-xs text-muted-foreground">{p.providerTransactionId}</span> : null}
                      </Td>
                      <Td label="Status">
                        <PaymentStatusBadge status={p.status} />
                      </Td>
                      <Td label="Reconciled">
                        {rec ? (
                          <div className="min-w-0 text-right md:text-left">
                            <Badge tone={rec.tone}>{rec.label}</Badge>
                            {p.reconciliation === "partly_allocated" || p.reconciliation === "credit" ? <span className="block text-xs text-muted-foreground">{formatMoney(p.unallocated, p.currency)} unused</span> : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td label="Activation" className="whitespace-nowrap text-sm">
                        {p.activation ? (
                          p.activation.activatedAt ? (
                            <span title={formatDateTime(p.activation.activatedAt, tz)}>{p.activation.seconds !== null ? `Online after ${p.activation.seconds < 60 ? `${p.activation.seconds} s` : `${Math.round(p.activation.seconds / 60)} min`}` : "Online"}</span>
                          ) : p.status === "CONFIRMED" ? (
                            <Badge tone="warning">Not confirmed on router</Badge>
                          ) : (
                            "—"
                          )
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td label="Amount" className="tabular whitespace-nowrap md:text-right">
                        {formatMoney(p.amount.toString(), p.currency)}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/payments", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
