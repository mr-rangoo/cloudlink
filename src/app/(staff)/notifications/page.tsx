import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listNotifications, listTemplates, notificationListQuery } from "@/server/services/notifications";
import { messagingStatus } from "@/server/integrations/messaging";
import { maskContact } from "@/server/observability/logger";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader, type Tone } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs } from "@/components/list-toolbar";
import { humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { RetryButton, TemplateDialog } from "./client";

export const metadata: Metadata = { title: "Notifications" };

const STATUS_TONE: Record<string, Tone> = { QUEUED: "info", SENT: "success", DELIVERED: "success", FAILED: "danger", SKIPPED: "neutral" };
const INTEGRATION_TONE: Record<string, Tone> = { mock: "warning", not_configured: "neutral", sandbox_tested: "info", production_verified: "success", error: "danger" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("notifications.read");
  if (!allowed) return <Forbidden what="notifications" />;
  const sp = await searchParams;
  const tab = sp.tab === "templates" ? "templates" : "messages";
  const canWrite = ctx.permissions.has("notifications.write");
  const tz = ctx.organization.timezone;
  const status = messagingStatus();

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="SMS and email sent to subscribers. Messages are marked simulated when a mock adapter is used, and skipped (never faked) when no provider is configured." />
      <div className="grid gap-4 sm:grid-cols-2">
        {(["sms", "email"] as const).map((ch) => (
          <Card key={ch}>
            <CardContent className="flex items-center justify-between py-4 text-sm">
              <span>
                <span className="font-medium uppercase">{ch}</span> <span className="text-muted-foreground">via {status[ch].provider}</span>
              </span>
              <Badge tone={INTEGRATION_TONE[status[ch].status] ?? "neutral"}>{status[ch].status.replace("_", " ")}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
      <FilterTabs
        label="Notifications view"
        active={tab}
        items={[
          { value: "messages", label: "Messages", href: "/notifications" },
          { value: "templates", label: "Templates", href: "/notifications?tab=templates" },
        ]}
      />
      {tab === "messages" ? <Messages sp={sp} canWrite={canWrite} tz={tz} ctx={ctx} /> : <Templates ctx={ctx} canWrite={canWrite} />}
    </div>
  );
}

async function Messages({ sp, canWrite, tz, ctx }: { sp: Record<string, string | undefined>; canWrite: boolean; tz: string; ctx: Parameters<typeof listNotifications>[0] }) {
  const parsed = notificationListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : notificationListQuery.parse({});
  const { rows, total } = await listNotifications(ctx, query);
  const current = { status: sp.status };
  return (
    <Card>
      <div className="border-b border-border p-4">
        <FilterTabs
          label="Message status"
          active={query.status}
          items={["ALL", "QUEUED", "SENT", "FAILED", "SKIPPED"].map((s) => ({ value: s, label: s === "ALL" ? "All" : humanize(s), href: buildHref("/notifications", current, { status: s === "ALL" ? undefined : s, page: undefined }) }))}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Bell} title="No messages" description="Invoice notices, payment confirmations, ticket replies and portal invites appear here." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Created</Th>
                <Th>Message</Th>
                <Th>Channel</Th>
                <Th>Recipient</Th>
                <Th>Status</Th>
                {canWrite ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </THead>
            <TBody>
              {rows.map((n) => (
                <Tr key={n.id}>
                  <Td label="Created" className="whitespace-nowrap">
                    {formatDateTime(n.createdAt, tz)}
                  </Td>
                  <Td label="Message">
                    <span className="font-mono text-xs">{n.templateKey}</span>
                    <span className="block max-w-md truncate text-xs text-muted-foreground" title={n.body}>
                      {n.subject ? `${n.subject} — ` : ""}
                      {n.body}
                    </span>
                    {n.subscriberId ? (
                      <Link href={`/subscribers/${n.subscriberId}`} className="text-xs text-accent hover:underline">
                        View subscriber
                      </Link>
                    ) : null}
                  </Td>
                  <Td label="Channel">{n.channel}</Td>
                  <Td label="Recipient" className="font-mono text-xs">
                    {maskContact(n.recipient)}
                  </Td>
                  <Td label="Status">
                    <span className="flex flex-col items-end gap-1 md:items-start">
                      <Badge tone={STATUS_TONE[n.status] ?? "neutral"}>{humanize(n.status)}</Badge>
                      {n.simulated ? <span className="text-xs text-warning">simulated (mock)</span> : null}
                      {n.lastError ? <span className="text-xs text-muted-foreground">{n.lastError}</span> : null}
                    </span>
                  </Td>
                  {canWrite ? (
                    <Td label="Actions" className="md:text-right">
                      {(n.status === "FAILED" || n.status === "SKIPPED") && n.templateKey !== "portal.invite" ? <RetryButton id={n.id} /> : null}
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/notifications", current, { page: p })} />
        </>
      )}
    </Card>
  );
}

async function Templates({ ctx, canWrite }: { ctx: Parameters<typeof listTemplates>[0]; canWrite: boolean }) {
  const templates = await listTemplates(ctx);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {templates.map((t) => (
        <Card key={`${t.key}-${t.channel}`}>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="font-mono text-xs">
                {t.key} · {t.channel}
              </CardTitle>
              <CardDescription>
                {humanize(t.category)} · {t.customised ? "customised" : "default"} · {t.active ? "active" : "disabled"}
              </CardDescription>
            </div>
            {canWrite ? <TemplateDialog template={t} /> : null}
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {t.subject ? <p className="font-medium">{t.subject}</p> : null}
            <p className="whitespace-pre-wrap text-muted-foreground">{t.body}</p>
            <p className="pt-1 text-xs text-muted-foreground">Variables: {t.variables.map((v) => `{{${v}}}`).join(" ")}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
