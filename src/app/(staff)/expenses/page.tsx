import type { Metadata } from "next";
import { Receipt } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { financeListQuery, listExpenseCategories, listExpenses } from "@/server/services/finance";
import { listAccessibleBranches } from "@/server/auth/service";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { METHOD_LABEL } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatMoney } from "@/lib/utils";
import { ExpenseDialog, ReverseExpenseButton } from "./client";

export const metadata: Metadata = { title: "Expenses" };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("expenses.read");
  if (!allowed) return <Forbidden what="expenses" />;
  const sp = await searchParams;
  const query = financeListQuery.parse({ page: sp.page ?? 1 });
  const canWrite = ctx.permissions.has("expenses.write");
  const [{ rows, total }, categories, branches] = await Promise.all([listExpenses(ctx, query), listExpenseCategories(ctx), canWrite ? listAccessibleBranches(ctx) : Promise.resolve([])]);
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description="Operating costs paid from cash, bank or M-Pesa. Each expense posts to the ledger; corrections are reversals."
        actions={canWrite ? <ExpenseDialog currency={ctx.organization.currency} categories={categories.map((c) => ({ id: c.id, name: c.name }))} branches={branches} /> : null}
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState icon={Receipt} title="No expenses recorded" />
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
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/expenses", {}, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
