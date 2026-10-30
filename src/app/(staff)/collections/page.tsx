import type { Metadata } from "next";
import Link from "next/link";
import { getStaffContextWith } from "@/server/auth/page";
import { collectionsSummary, financeListQuery, listWithdrawals } from "@/server/services/finance";
import { listAccessibleBranches } from "@/server/auth/service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { METHOD_LABEL } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatMoney } from "@/lib/utils";
import { WithdrawalDialog } from "./client";

export const metadata: Metadata = { title: "Collections" };

const ACCOUNT_LABEL: Record<string, string> = { CASH: "Cash on hand", BANK: "Bank", MPESA: "M-Pesa", OTHER_RECEIPTS: "Other receipts" };

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("expenses.read");
  if (!allowed) return <Forbidden what="collections" />;
  const sp = await searchParams;
  const canWrite = ctx.permissions.has("expenses.write");
  const [summary, withdrawals, branches] = await Promise.all([collectionsSummary(ctx, sp.month), listWithdrawals(ctx, financeListQuery.parse({ pageSize: 20 })), canWrite ? listAccessibleBranches(ctx) : Promise.resolve([])]);
  const cur = ctx.organization.currency;
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash collections"
        description="Money received, refunded and spent per month, and where it is held according to the ledger."
        actions={canWrite ? <WithdrawalDialog currency={cur} branches={branches} /> : null}
      />
      <div className="flex items-center gap-2 text-sm">
        <Link href={`/collections?month=${shiftMonth(summary.month, -1)}`} className="rounded-md border border-border px-2.5 py-1 hover:bg-surface-muted">
          ← Previous
        </Link>
        <span className="font-medium">{summary.month}</span>
        <Link href={`/collections?month=${shiftMonth(summary.month, 1)}`} className="rounded-md border border-border px-2.5 py-1 hover:bg-surface-muted">
          Next →
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Collected" value={formatMoney(summary.collected, cur)} hint="Confirmed payments received" />
        <Stat label="Refunded" value={formatMoney(summary.refunds, cur)} hint="Refunds paid out" />
        <Stat label="Expenses" value={formatMoney(summary.expenses, cur)} hint="Recorded, not reversed" />
        <Stat label="Net" value={formatMoney(summary.net, cur)} hint="Collected − refunds − expenses" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Collections by method</CardTitle>
          </CardHeader>
          {summary.byMethod.length ? (
            <Table>
              <THead>
                <tr>
                  <Th>Method</Th>
                  <Th className="text-right">Payments</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </THead>
              <TBody>
                {summary.byMethod.map((r) => (
                  <Tr key={r.method}>
                    <Td label="Method">{METHOD_LABEL[r.method]}</Td>
                    <Td label="Payments" className="tabular md:text-right">
                      {r.count}
                    </Td>
                    <Td label="Amount" className="tabular md:text-right">
                      {formatMoney(r.amount, cur)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          ) : (
            <CardContent className="text-sm text-muted-foreground">No payments this month.</CardContent>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Balances held (ledger, all time)</CardTitle>
            <CardDescription>Owner drawings this month: {formatMoney(summary.ownerDrawings, cur)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {summary.ledgerBalances.map((b) => (
              <div key={b.account} className="flex justify-between">
                <span className="text-muted-foreground">{ACCOUNT_LABEL[b.account]}</span>
                <span className="tabular font-medium">{formatMoney(b.balance, cur)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Withdrawals and bank deposits</CardTitle>
        </CardHeader>
        {withdrawals.rows.length ? (
          <Table>
            <THead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>From</Th>
                <Th>Description</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </THead>
            <TBody>
              {withdrawals.rows.map((w) => (
                <Tr key={w.id}>
                  <Td label="Date">{formatDate(w.occurredAt, tz)}</Td>
                  <Td label="Type">{w.kind === "OWNER_DRAWING" ? "Owner drawing" : "Bank deposit"}</Td>
                  <Td label="From">{METHOD_LABEL[w.fromMethod]}</Td>
                  <Td label="Description">{w.description}</Td>
                  <Td label="Amount" className="tabular md:text-right">
                    {formatMoney(w.amount.toString(), w.currency)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        ) : (
          <CardContent className="text-sm text-muted-foreground">None recorded.</CardContent>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="tabular text-xl font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
