import type { Metadata } from "next";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { inventoryQuery, listInventory } from "@/server/services/inventory";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader, type Tone } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatMoney } from "@/lib/utils";
import { ItemActions, NewItemDialog } from "./client";

export const metadata: Metadata = { title: "Inventory" };

const TONE: Record<string, Tone> = { IN_STOCK: "success", ASSIGNED: "info", FAULTY: "danger", RETIRED: "neutral" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("inventory.read");
  if (!allowed) return <Forbidden what="inventory" />;
  const sp = await searchParams;
  const parsed = inventoryQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : inventoryQuery.parse({});
  const { rows, total, counts } = await listInventory(ctx, query);
  const canWrite = ctx.permissions.has("inventory.write");
  const current = { q: sp.q, status: sp.status };
  const href = (status?: string) => buildHref("/inventory", current, { status, page: undefined });

  return (
    <div className="space-y-6">
      <PageHeader title="Inventory" description="Routers, ONUs and other equipment, with a full movement history per item." actions={canWrite ? <NewItemDialog /> : null} />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Inventory status"
            active={query.status}
            items={[
              { value: "ALL", label: "All", href: href(undefined) },
              ...(["IN_STOCK", "ASSIGNED", "FAULTY", "RETIRED"] as const).map((s) => ({ value: s, label: humanize(s), count: (counts as Record<string, number>)[s] ?? 0, href: href(s) })),
            ]}
          />
          <SearchForm action="/inventory" q={sp.q} placeholder="Serial, model or MAC" hidden={{ status: sp.status }} />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={Boxes} title="No equipment recorded" description={canWrite ? "Add items as they arrive; assign them to subscribers at installation." : undefined} />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Item</Th>
                  <Th>Serial / MAC</Th>
                  <Th>Status</Th>
                  <Th>Assigned to</Th>
                  <Th className="text-right">Cost</Th>
                  {canWrite ? <Th className="text-right">Actions</Th> : null}
                </tr>
              </THead>
              <TBody>
                {rows.map((i) => (
                  <Tr key={i.id}>
                    <Td label="Item">
                      <span className="font-medium">{i.model}</span>
                      <span className="block text-xs text-muted-foreground">{humanize(i.category)}</span>
                    </Td>
                    <Td label="Serial / MAC" className="font-mono text-xs">
                      {i.serialNumber}
                      {i.macAddress ? <span className="block text-muted-foreground">{i.macAddress}</span> : null}
                    </Td>
                    <Td label="Status">
                      <Badge tone={TONE[i.status] ?? "neutral"}>{humanize(i.status)}</Badge>
                    </Td>
                    <Td label="Assigned to">
                      {i.subscriber ? (
                        <Link href={`/subscribers/${i.subscriber.id}`} className="hover:underline">
                          {i.subscriber.displayName}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td label="Cost" className="tabular md:text-right">
                      {i.purchaseCost ? formatMoney(i.purchaseCost.toString(), ctx.organization.currency) : "—"}
                    </Td>
                    {canWrite ? (
                      <Td label="Actions" className="md:text-right">
                        <ItemActions id={i.id} status={i.status} label={`${i.model} ${i.serialNumber}`} />
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/inventory", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
