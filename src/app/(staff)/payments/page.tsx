import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Wallet } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listPayments, paymentListQuery } from "@/server/services/payments";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { buttonVariants } from "@/components/ui/button";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { METHOD_LABEL, PaymentStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("payments.read");
  if (!allowed) return <Forbidden what="payments" />;
  const sp = await searchParams;
  const parsed = paymentListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : paymentListQuery.parse({});
  const { rows, total, confirmedTotal } = await listPayments(ctx, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = { q: sp.q, status: sp.status, method: sp.method, unmatched: sp.unmatched };
  const tz = ctx.organization.timezone;
  const active = query.unmatched ? "UNMATCHED" : query.status;
  const href = (patch: Record<string, string | undefined>) => buildHref("/payments", current, { ...patch, page: undefined });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description={`Confirmed in this view: ${formatMoney(confirmedTotal, ctx.organization.currency)}. Payments are confirmed by staff entry or provider callbacks, never by a browser redirect.`}
        actions={
          ctx.permissions.has("payments.record") ? (
            <Link href="/payments/new" className={buttonVariants()}>
              <Plus /> Record payment
            </Link>
          ) : null
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
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
          <SearchForm action="/payments" q={sp.q} placeholder="Receipt, reference or payer" hidden={{ status: sp.status, unmatched: sp.unmatched }} />
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
                  <Th>Method</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">Unallocated</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((p) => (
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
                        <span className="text-warning">Unmatched{p.payerName ? ` · ${p.payerName}` : ""}</span>
                      )}
                    </Td>
                    <Td label="Method">
                      {METHOD_LABEL[p.method]}
                      {p.providerTransactionId ? <span className="block font-mono text-xs text-muted-foreground">{p.providerTransactionId}</span> : null}
                    </Td>
                    <Td label="Status">
                      <PaymentStatusBadge status={p.status} />
                    </Td>
                    <Td label="Amount" className="tabular whitespace-nowrap md:text-right">
                      {formatMoney(p.amount.toString(), p.currency)}
                    </Td>
                    <Td label="Unallocated" className="tabular whitespace-nowrap md:text-right">
                      {p.status === "CONFIRMED" && Number(p.unallocated) > 0 ? formatMoney(p.unallocated, p.currency) : "—"}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/payments", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
