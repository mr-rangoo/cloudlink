import type { Metadata } from "next";
import Link from "next/link";
import { Smartphone } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { attemptListQuery, listAttempts } from "@/server/services/mobile-money";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { Card } from "@/components/ui/card";
import { Alert, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs } from "@/components/list-toolbar";
import { AttemptBadge } from "@/components/mpesa-request";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "M-Pesa requests" };

const FILTERS = [
  ["ALL", "All"],
  ["OPEN", "In progress"],
  ["CONFIRMED", "Paid"],
  ["UNKNOWN", "Needs review"],
  ["FAILED", "Failed"],
  ["CANCELLED", "Cancelled"],
  ["EXPIRED", "No response"],
] as const;

export default async function PaymentRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("payments.read");
  if (!allowed) return <Forbidden what="payments" />;
  const sp = await searchParams;
  const parsed = attemptListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : attemptListQuery.parse({});
  const { rows, total, counts } = await listAttempts(ctx, query);
  const tz = ctx.organization.timezone;
  const mode = paymentAdapterMode();
  const current = { status: sp.status };
  const countFor = (s: string) => (s === "OPEN" ? (counts.PENDING ?? 0) + (counts.SUBMITTED ?? 0) : s === "ALL" ? undefined : (counts as Record<string, number>)[s] ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="M-Pesa requests"
        description="Every STK Push prompt sent to a customer's phone and what M-Pesa reported. Money is recorded only after M-Pesa confirms it."
      />
      {mode === "mock" ? <Alert tone="warning" title="Mock payment adapter">Requests are simulated: no prompt is sent and no money moves.</Alert> : null}
      <Card>
        <div className="border-b border-border p-4">
          <FilterTabs
            label="Request status"
            active={query.status}
            items={FILTERS.map(([value, label]) => ({ value, label, count: countFor(value), href: buildHref("/payments/requests", current, { status: value === "ALL" ? undefined : value, page: undefined }) }))}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={Smartphone} title="No M-Pesa requests" description="Use “Request M-Pesa” on a subscriber's billing card, or let customers pay from the portal." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Requested</Th>
                  <Th>Subscriber</Th>
                  <Th>Phone</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Channel</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((a) => (
                  <Tr key={a.id}>
                    <Td label="Requested">
                      <Link href={`/payments/requests/${a.id}`} className="text-accent hover:underline">
                        {formatDateTime(a.createdAt, tz)}
                      </Link>
                    </Td>
                    <Td label="Subscriber">
                      {a.subscriber ? (
                        <Link href={`/subscribers/${a.subscriber.id}`} className="hover:underline">
                          {a.subscriber.displayName} · {a.subscriber.accountNumber}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td label="Phone" className="font-mono text-xs">
                      {a.phone}
                    </Td>
                    <Td label="Amount" className="tabular md:text-right">
                      {formatMoney(a.amount, a.currency)}
                    </Td>
                    <Td label="Status">
                      <AttemptBadge status={a.status} simulated={a.simulated} />
                    </Td>
                    <Td label="Channel">{a.channel === "portal" ? "Customer portal" : "Staff"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/payments/requests", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
