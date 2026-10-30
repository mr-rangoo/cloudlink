import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { invoiceListQuery, listInvoices } from "@/server/services/invoices";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { buttonVariants } from "@/components/ui/button";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { InvoiceStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatMoney } from "@/lib/utils";
import { RunBillingButton } from "./run-billing";

export const metadata: Metadata = { title: "Invoices" };

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("invoices.read");
  if (!allowed) return <Forbidden what="invoices" />;
  const sp = await searchParams;
  const parsed = invoiceListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : invoiceListQuery.parse({});
  const { rows, total, outstanding } = await listInvoices(ctx, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = { q: sp.q, status: sp.status };
  const tz = ctx.organization.timezone;
  const cur = ctx.organization.currency;
  const tab = (status: string) => ({ value: status, href: buildHref("/invoices", current, { status: status === "ALL" ? undefined : status, page: undefined }) });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer invoices"
        description={`Outstanding in this view: ${formatMoney(outstanding, cur)}`}
        actions={
          <>
            {ctx.permissions.has("invoices.issue") ? <RunBillingButton /> : null}
            {ctx.permissions.has("invoices.write") ? (
              <Link href="/invoices/new" className={buttonVariants()}>
                <Plus /> New invoice
              </Link>
            ) : null}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Invoice status"
            active={query.status}
            items={[
              { ...tab("ALL"), label: "All" },
              { ...tab("UNPAID"), label: "Unpaid" },
              { ...tab("OVERDUE"), label: "Overdue" },
              { ...tab("PARTIALLY_PAID"), label: "Part paid" },
              { ...tab("PAID"), label: "Paid" },
              { ...tab("DRAFT"), label: "Drafts" },
              { ...tab("VOID"), label: "Void" },
            ]}
          />
          <SearchForm action="/invoices" q={sp.q} placeholder="Invoice number" hidden={{ status: sp.status }} />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={FileText} title="No invoices match" description="Invoices are generated when subscriptions activate and before each billing period, or created manually." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Subscriber</Th>
                  <Th>Status</Th>
                  <Th>Issued</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Balance</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((inv) => (
                  <Tr key={inv.id}>
                    <Td label="Invoice" className="font-mono text-xs">
                      <Link href={`/invoices/${inv.id}`} className="text-accent hover:underline">
                        {inv.invoiceNumber ?? "Draft"}
                      </Link>
                    </Td>
                    <Td label="Subscriber">
                      {inv.subscriber ? (
                        <Link href={`/subscribers/${inv.subscriber.id}`} className="hover:underline">
                          {inv.subscriber.displayName}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td label="Status">
                      <InvoiceStatusBadge status={inv.status} overdue={inv.overdue} />
                    </Td>
                    <Td label="Issued" className="whitespace-nowrap">
                      {formatDate(inv.issuedAt, tz)}
                    </Td>
                    <Td label="Due" className="whitespace-nowrap">
                      {formatDate(inv.dueAt, tz)}
                    </Td>
                    <Td label="Total" className="tabular whitespace-nowrap md:text-right">
                      {formatMoney(inv.total.toString(), inv.currency)}
                    </Td>
                    <Td label="Balance" className="tabular whitespace-nowrap font-medium md:text-right">
                      {inv.status === "VOID" ? "—" : formatMoney(inv.balanceDue.toString(), inv.currency)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/invoices", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
