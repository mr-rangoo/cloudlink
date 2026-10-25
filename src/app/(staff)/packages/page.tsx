import type { Metadata } from "next";
import { Package as PackageIcon } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listPackages, packageListQuery } from "@/server/services/packages";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { RecordStatusBadge, SERVICE_LABEL, formatInterval, formatSpeed } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatMoney } from "@/lib/utils";
import { PackageDialog } from "./package-dialog";

export const metadata: Metadata = { title: "Packages" };

export default async function PackagesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("packages.read");
  if (!allowed) return <Forbidden what="packages" />;
  const sp = await searchParams;
  const query = packageListQuery.parse({ q: sp.q, status: sp.status ?? "ACTIVE" });
  const packages = await listPackages(ctx, query);
  const canWrite = ctx.permissions.has("packages.write");
  const current = { q: sp.q, status: sp.status };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Packages"
        description="Service plans and pricing. Price changes apply to new subscriptions; existing subscriptions keep their agreed terms."
        actions={canWrite ? <PackageDialog currency={ctx.organization.currency} /> : null}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <FilterTabs
            label="Package status"
            active={query.status}
            items={[
              { value: "ACTIVE", label: "Active", href: buildHref("/packages", current, { status: "ACTIVE" }) },
              { value: "INACTIVE", label: "Inactive", href: buildHref("/packages", current, { status: "INACTIVE" }) },
              { value: "ARCHIVED", label: "Archived", href: buildHref("/packages", current, { status: "ARCHIVED" }) },
              { value: "ALL", label: "All", href: buildHref("/packages", current, { status: "ALL" }) },
            ]}
          />
          <SearchForm action="/packages" q={sp.q} placeholder="Search packages" hidden={{ status: sp.status }} />
        </div>
        {packages.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title={sp.q ? "No packages match your search" : "No packages yet"}
            description={canWrite ? "Create your first service plan to start onboarding subscribers." : "Packages created by your administrators will appear here."}
            action={canWrite && !sp.q ? <PackageDialog currency={ctx.organization.currency} /> : undefined}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Package</Th>
                <Th>Type</Th>
                <Th className="text-right">Price</Th>
                <Th>Speed (down / up)</Th>
                <Th className="text-right">Live subs</Th>
                <Th>Status</Th>
                {canWrite ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </THead>
            <TBody>
              {packages.map((p) => (
                <Tr key={p.id}>
                  <Td label="Package">
                    <div>
                      <p className="font-medium">{p.name}</p>
                      {p.description ? <p className="max-w-xs truncate text-xs text-muted-foreground">{p.description}</p> : null}
                    </div>
                  </Td>
                  <Td label="Type">{SERVICE_LABEL[p.serviceType]}</Td>
                  <Td label="Price" className="tabular md:text-right">
                    <span>
                      {formatMoney(p.price.toString(), p.currency)} <span className="text-xs text-muted-foreground">{formatInterval(p.billingUnit, p.billingCount)}</span>
                      {Number(p.taxRate) > 0 ? <span className="block text-xs text-muted-foreground">+{p.taxRate.toString()}% tax</span> : null}
                    </span>
                  </Td>
                  <Td label="Speed">
                    {formatSpeed(p.downloadKbps)} / {formatSpeed(p.uploadKbps)}
                  </Td>
                  <Td label="Live subscriptions" className="tabular md:text-right">
                    {p.activeSubscriptions}
                  </Td>
                  <Td label="Status">
                    <RecordStatusBadge status={p.status} />
                  </Td>
                  {canWrite ? (
                    <Td label="Actions" className="md:text-right">
                      <PackageDialog
                        currency={p.currency}
                        initial={{
                          id: p.id,
                          name: p.name,
                          description: p.description ?? "",
                          serviceType: p.serviceType,
                          price: p.price.toFixed(2),
                          taxRate: p.taxRate.toString(),
                          billingUnit: p.billingUnit,
                          billingCount: p.billingCount,
                          downloadKbps: p.downloadKbps,
                          uploadKbps: p.uploadKbps,
                          dataQuotaMb: p.dataQuotaMb,
                          deviceLimit: p.deviceLimit,
                          status: p.status,
                        }}
                      />
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
