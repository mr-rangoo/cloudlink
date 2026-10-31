import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Router as RouterIcon } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listRouters, routerListQuery } from "@/server/services/routers";
import { listAccessibleBranches } from "@/server/auth/service";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { buttonVariants } from "@/components/ui/button";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { RouterStatusBadge } from "@/components/status";
import { StatStrip } from "@/components/stat-strip";
import { AdapterNotice } from "@/components/network-notice";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { RouterFormDialog, RouterRowMenu } from "./client";

export const metadata: Metadata = { title: "Routers" };

export default async function RoutersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("routers.read");
  if (!allowed) return <Forbidden what="routers" />;
  const sp = await searchParams;
  const parsed = routerListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : routerListQuery.parse({});
  const { rows, total, adapter, summary } = await listRouters(ctx, query);
  const canWrite = ctx.permissions.has("routers.write");
  const branches = canWrite ? await listAccessibleBranches(ctx) : [];
  const tz = ctx.organization.timezone;
  const current = { q: sp.q, status: sp.status, archived: sp.archived };
  const href = (patch: Record<string, string | undefined>) => buildHref("/routers", current, { ...patch, page: undefined });
  const linkButton = (
    <Link href="/routers/link" className={buttonVariants()}>
      <Plus /> Link MikroTik
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your routers"
        description="MikroTik routers linked to Cloudlink. Link a new one with a single command; it checks in every minute."
        actions={
          canWrite ? (
            <>
              <RouterFormDialog branches={branches.map((b) => ({ id: b.id, name: b.name }))} triggerLabel="Add by IP address" />
              {linkButton}
            </>
          ) : null
        }
      />
      <AdapterNotice adapter={adapter} />
      <StatStrip
        stats={[
          { label: "Routers", value: summary.total, hint: summary.maintenance ? `${summary.maintenance} in maintenance` : "Not archived" },
          { label: "Online", value: summary.online, tone: summary.online ? "success" : "default", href: href({ status: "ONLINE", archived: undefined }) },
          { label: "Offline", value: summary.offline, tone: summary.offline ? "danger" : "default", href: href({ status: "OFFLINE", archived: undefined }) },
          { label: "Live sessions", value: summary.liveSessions, hint: "Across these routers", href: "/sessions" },
        ]}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Router status"
            active={query.archived === "true" ? "ARCHIVED" : query.status}
            items={[
              { value: "ALL", label: "All", href: href({ status: undefined, archived: undefined }), count: summary.total },
              { value: "ONLINE", label: "Online", href: href({ status: "ONLINE", archived: undefined }), count: summary.online },
              { value: "OFFLINE", label: "Offline", href: href({ status: "OFFLINE", archived: undefined }), count: summary.offline },
              { value: "UNKNOWN", label: adapter === "mock" ? "Simulated" : "Not checked", href: href({ status: "UNKNOWN", archived: undefined }), count: summary.unknown },
              { value: "ARCHIVED", label: "Archived", href: href({ status: undefined, archived: "true" }) },
            ]}
          />
          <SearchForm action="/routers" q={sp.q} placeholder="Name, address or identity" hidden={{ status: sp.status, archived: sp.archived }} />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={RouterIcon}
            title={query.q || query.status !== "ALL" || query.archived === "true" ? "No routers match" : "No routers linked yet"}
            description={canWrite && !query.q ? "Link your first MikroTik: name it, paste one command into its terminal, then choose hotspot or PPPoE and the ports to use." : undefined}
            action={canWrite && !query.q && query.status === "ALL" && query.archived !== "true" ? linkButton : undefined}
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Router</Th>
                  <Th>Status</Th>
                  <Th>Services</Th>
                  <Th className="text-right">Sessions</Th>
                  <Th>Last online</Th>
                  <Th className="w-12">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => {
                  const model = [r.boardName, r.routerOsVersion ? `RouterOS ${r.routerOsVersion}` : null].filter(Boolean).join(" · ");
                  return (
                    <Tr key={r.id}>
                      <Td label="Router">
                        <div className="min-w-0 text-right md:text-left">
                          <Link href={r.connection === "pending" ? `/routers/${r.id}/setup` : `/routers/${r.id}`} className="font-medium text-accent hover:underline">
                            {r.name}
                          </Link>
                          <span className="block text-xs text-muted-foreground">{model || (r.connection === "pending" ? "Waiting for the setup command" : "Model not reported yet")}</span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {r.connection === "api" ? `${r.host}:${r.apiPort}${r.useTls ? " · TLS" : ""}` : r.connection === "agent" ? "Cloudlink agent" : null}
                            {r.branchName ? <span className="font-sans"> · {r.branchName}</span> : null}
                          </span>
                        </div>
                      </Td>
                      <Td label="Status">
                        <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                          {r.connection === "pending" ? <Badge tone="warning">Not linked</Badge> : <RouterStatusBadge status={r.status} adapter={adapter} />}
                          {r.maintenanceMode ? <Badge tone="warning">Maintenance</Badge> : null}
                          {r.openAlerts ? <Badge tone="danger">{r.openAlerts === 1 ? "1 alert" : `${r.openAlerts} alerts`}</Badge> : null}
                        </span>
                      </Td>
                      <Td label="Services">
                        <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                          {r.pppoeEnabled ? <Badge tone="neutral">{r.pppoeAuth === "RADIUS" ? "PPPoE · RADIUS" : "PPPoE"}</Badge> : null}
                          {r.hotspotEnabled ? <Badge tone="neutral">Hotspot</Badge> : null}
                          {!r.pppoeEnabled && !r.hotspotEnabled ? <span className="text-muted-foreground">—</span> : null}
                        </span>
                      </Td>
                      <Td label="Sessions" className="tabular md:text-right">
                        {r.activeSessions}
                      </Td>
                      <Td label="Last online" className="text-sm">
                        {r.lastSeenAt ? formatDateTime(r.lastSeenAt, tz) : <span className="text-muted-foreground">Never</span>}
                      </Td>
                      <Td label="Actions" className="md:text-right">
                        <RouterRowMenu id={r.id} name={r.name} linked={r.connection !== "pending"} agent={r.connection !== "api"} canWrite={canWrite && !r.archivedAt} />
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/routers", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
