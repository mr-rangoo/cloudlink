import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { auditQuery, searchAuditLogs } from "@/server/services/admin";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Audit Logs" };

export default async function AuditLogsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("audit.read");
  if (!allowed) return <Forbidden what="audit logs" />;
  const sp = await searchParams;
  const parsed = auditQuery.safeParse(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)));
  const query = parsed.success ? parsed.data : auditQuery.parse({});
  const { rows, total } = await searchAuditLogs(ctx, query);
  const current = { action: sp.action, entityType: sp.entityType, entityId: sp.entityId, from: sp.from, to: sp.to, actor: sp.actor };
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" description="Security and change history for this organization. Sensitive values are redacted before they are recorded." />
      <Card>
        <form method="get" action="/audit-logs" className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <label className="space-y-1 text-sm lg:col-span-2">
            <span className="block text-xs text-muted-foreground">Action starts with</span>
            <Input name="action" defaultValue={sp.action} placeholder="e.g. payment. or auth.login" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">Entity type</span>
            <Input name="entityType" defaultValue={sp.entityType} placeholder="invoice" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">From</span>
            <Input type="date" name="from" defaultValue={sp.from} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">To</span>
            <Input type="date" name="to" defaultValue={sp.to} />
          </label>
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title="No matching entries" />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Details</Th>
                  <Th>Source</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td label="Time" className="whitespace-nowrap">
                      {formatDateTime(r.createdAt, tz)}
                    </Td>
                    <Td label="Actor">{r.actor ? r.actor.name : <span className="text-muted-foreground">{r.actorType}</span>}</Td>
                    <Td label="Action" className="font-mono text-xs">
                      {r.action}
                    </Td>
                    <Td label="Entity" className="text-xs">
                      {r.entityType ? (
                        <a href={buildHref("/audit-logs", {}, { entityType: r.entityType, entityId: r.entityId ?? undefined })} className="text-accent hover:underline">
                          {r.entityType}
                        </a>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td label="Details">
                      {r.metadata ? <code className="block max-w-xs truncate text-[11px] text-muted-foreground" title={JSON.stringify(r.metadata)}>{JSON.stringify(r.metadata)}</code> : "—"}
                    </Td>
                    <Td label="Source" className="text-xs text-muted-foreground">
                      {r.ipAddress ?? "—"}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/audit-logs", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
