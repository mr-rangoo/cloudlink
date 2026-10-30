import type { Metadata } from "next";
import Link from "next/link";
import { getStaffContextWith } from "@/server/auth/page";
import { db } from "@/server/db/client";
import { listPayments } from "@/server/services/payments";
import { computeTrialBalance } from "@/server/services/ledger";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { METHOD_LABEL } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";
import { RunChecksButton } from "./run-checks";

export const metadata: Metadata = { title: "Reconciliation" };

export default async function ReconciliationPage() {
  const { ctx, allowed } = await getStaffContextWith("payments.reconcile");
  if (!allowed) return <Forbidden what="reconciliation" />;
  const tz = ctx.organization.timezone;
  const cur = ctx.organization.currency;
  const [unmatched, last, tb] = await Promise.all([
    listPayments(ctx, { status: "ALL", unmatched: "1", page: 1, pageSize: 50 }),
    db.reconciliationRecord.findFirst({ where: { organizationId: ctx.organizationId, action: "balance_check" }, orderBy: { createdAt: "desc" } }),
    computeTrialBalance(ctx.organizationId),
  ]);
  const details = (last?.details ?? null) as null | {
    invoiceCacheMismatches: unknown[];
    paymentCacheMismatches: unknown[];
    receivables: { invoices: string; ledger: string; matches: boolean };
    ledgerBalanced: boolean;
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Payment reconciliation" description="Match unidentified receipts, and verify that cached balances agree with the payment, allocation and ledger records." actions={<RunChecksButton />} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Latest balance check</CardTitle>
            <CardDescription>{last ? formatDateTime(last.createdAt, tz) : "Not run yet"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {details ? (
              <>
                <Check ok={last!.outcome === "ok"} label={last!.outcome === "ok" ? "All checks passed" : "Mismatch found"} />
                <Check ok={details.invoiceCacheMismatches.length === 0} label={`Invoice balances (${details.invoiceCacheMismatches.length} mismatches)`} />
                <Check ok={details.paymentCacheMismatches.length === 0} label={`Payment balances (${details.paymentCacheMismatches.length} mismatches)`} />
                <Check ok={details.receivables.matches} label={`Receivables: invoices ${formatMoney(details.receivables.invoices, cur)} vs ledger ${formatMoney(details.receivables.ledger, cur)}`} />
                <Check ok={details.ledgerBalanced} label="Ledger debits equal credits" />
              </>
            ) : (
              <p className="text-muted-foreground">Run the checks to verify the books.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Trial balance</CardTitle>
            <CardDescription>Debit − credit per account (credit-normal accounts show negative balances)</CardDescription>
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <Th>Account</Th>
                <Th className="text-right">Debits</Th>
                <Th className="text-right">Credits</Th>
                <Th className="text-right">Balance</Th>
              </tr>
            </THead>
            <TBody>
              {tb.accounts.map((a) => (
                <Tr key={a.code}>
                  <Td label="Account">
                    <span className="font-mono text-xs text-muted-foreground">{a.code}</span> {a.name}
                  </Td>
                  <Td label="Debits" className="tabular md:text-right">
                    {formatMoney(a.debit, cur)}
                  </Td>
                  <Td label="Credits" className="tabular md:text-right">
                    {formatMoney(a.credit, cur)}
                  </Td>
                  <Td label="Balance" className="tabular font-medium md:text-right">
                    {formatMoney(a.balance, cur)}
                  </Td>
                </Tr>
              ))}
              <Tr>
                <Td label="Totals" className="font-semibold">
                  Totals {tb.balanced ? <Badge tone="success">balanced</Badge> : <Badge tone="danger">unbalanced</Badge>}
                </Td>
                <Td label="Debits" className="tabular font-semibold md:text-right">
                  {formatMoney(tb.totalDebit, cur)}
                </Td>
                <Td label="Credits" className="tabular font-semibold md:text-right">
                  {formatMoney(tb.totalCredit, cur)}
                </Td>
                <Td label="">{""}</Td>
              </Tr>
            </TBody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Unmatched payments</CardTitle>
          <CardDescription>{unmatched.total ? `${unmatched.total} receipt(s) awaiting a subscriber` : "Nothing to match"}</CardDescription>
        </CardHeader>
        {unmatched.rows.length ? (
          <Table>
            <THead>
              <tr>
                <Th>Receipt</Th>
                <Th>Received</Th>
                <Th>Payer / account entered</Th>
                <Th>Method</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </THead>
            <TBody>
              {unmatched.rows.map((p) => (
                <Tr key={p.id}>
                  <Td label="Receipt">
                    <Link href={`/payments/${p.id}`} className="font-mono text-xs text-accent hover:underline">
                      {p.receiptNumber}
                    </Link>
                  </Td>
                  <Td label="Received">{formatDateTime(p.receivedAt, tz)}</Td>
                  <Td label="Payer">{[p.payerName, p.accountReference].filter(Boolean).join(" · ") || "—"}</Td>
                  <Td label="Method">
                    {METHOD_LABEL[p.method]} {p.providerTransactionId ? <span className="font-mono text-xs text-muted-foreground">{p.providerTransactionId}</span> : null}
                  </Td>
                  <Td label="Amount" className="tabular md:text-right">
                    {formatMoney(p.amount.toString(), p.currency)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        ) : null}
      </Card>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-start gap-2">
      <Badge tone={ok ? "success" : "danger"}>{ok ? "OK" : "Check"}</Badge>
      <span>{label}</span>
    </div>
  );
}
