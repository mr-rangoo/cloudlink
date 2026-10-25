import type { Metadata } from "next";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { LEAD_STAGES, leadListQuery, listAssignableStaff, listLeads } from "@/server/services/leads";
import { listPackages } from "@/server/services/packages";
import { formatPhone } from "@/server/domain/contact";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { LeadStageBadge, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate } from "@/lib/utils";
import { NewLeadDialog } from "./client";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("leads.read");
  if (!allowed) return <Forbidden what="leads" />;
  const sp = await searchParams;
  const parsed = leadListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : leadListQuery.parse({});
  const canWrite = ctx.permissions.has("leads.write");
  const [{ rows, total, stageCounts }, staff, packages] = await Promise.all([
    listLeads(ctx, query),
    canWrite ? listAssignableStaff(ctx) : Promise.resolve([]),
    canWrite && ctx.permissions.has("packages.read") ? listPackages(ctx, { status: "ACTIVE" }) : Promise.resolve([]),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = { q: sp.q, stage: sp.stage, owner: sp.owner, source: sp.source };
  const open = LEAD_STAGES.filter((s) => s !== "WON" && s !== "LOST").reduce((n, s) => n + (stageCounts[s] ?? 0), 0);
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM / Leads"
        description="Track prospects from first contact to conversion."
        actions={canWrite ? <NewLeadDialog staff={staff} packages={packages.map((p) => ({ id: p.id, name: p.name }))} currentUserId={ctx.userId} /> : null}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <FilterTabs
            label="Lead stage"
            active={query.stage}
            items={[
              { value: "OPEN", label: "Open", count: open, href: buildHref("/leads", current, { stage: "OPEN", page: undefined }) },
              ...LEAD_STAGES.map((s) => ({ value: s, label: humanize(s), count: stageCounts[s] ?? 0, href: buildHref("/leads", current, { stage: s, page: undefined }) })),
              { value: "ALL", label: "All", href: buildHref("/leads", current, { stage: "ALL", page: undefined }) },
            ]}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <FilterTabs
              label="Owner"
              active={query.owner ?? "any"}
              items={[
                { value: "any", label: "Anyone", href: buildHref("/leads", current, { owner: undefined, page: undefined }) },
                { value: "me", label: "Mine", href: buildHref("/leads", current, { owner: "me", page: undefined }) },
                { value: "unassigned", label: "Unassigned", href: buildHref("/leads", current, { owner: "unassigned", page: undefined }) },
              ]}
            />
            <SearchForm action="/leads" q={sp.q} placeholder="Name, phone, location" hidden={{ stage: sp.stage, owner: sp.owner }} />
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={UserPlus} title="No leads here" description={canWrite ? "Capture walk-ins, referrals and enquiries as leads to track them to conversion." : undefined} />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Lead</Th>
                  <Th>Phone</Th>
                  <Th>Stage</Th>
                  <Th>Source</Th>
                  <Th>Interested in</Th>
                  <Th>Owner</Th>
                  <Th>Created</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((l) => (
                  <Tr key={l.id}>
                    <Td label="Lead">
                      <div className="text-right md:text-left">
                        <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                          {l.name}
                        </Link>
                        {l.location ? <p className="text-xs text-muted-foreground">{l.location}</p> : null}
                      </div>
                    </Td>
                    <Td label="Phone" className="tabular whitespace-nowrap">
                      {formatPhone(l.phone)}
                    </Td>
                    <Td label="Stage">
                      <LeadStageBadge stage={l.stage} />
                    </Td>
                    <Td label="Source">{humanize(l.source)}</Td>
                    <Td label="Interested in">{l.interestedPackage?.name ?? "—"}</Td>
                    <Td label="Owner">{l.ownerName ?? <span className="text-muted-foreground">Unassigned</span>}</Td>
                    <Td label="Created" className="whitespace-nowrap text-muted-foreground">
                      {formatDate(l.createdAt, tz)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/leads", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
