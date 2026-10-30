import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listNotifications, listTemplates, notificationListQuery } from "@/server/services/notifications";
import { messagingInUse } from "@/server/services/messaging-config";
import { maskContact } from "@/server/observability/logger";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader, type Tone } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs } from "@/components/list-toolbar";
import { humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { RetryButton, TemplateDialog } from "./client";
import { CampaignDialog, CancelCampaignButton, SendCampaignDialog, type CampaignDraft } from "./campaign-client";
import { listCampaigns } from "@/server/services/campaigns";
import { routerNameOptions } from "@/server/services/routers";
import { listPackages } from "@/server/services/packages";

export const metadata: Metadata = { title: "Notifications" };

const STATUS_TONE: Record<string, Tone> = { QUEUED: "info", SENT: "success", DELIVERED: "success", FAILED: "danger", SKIPPED: "neutral" };
const INTEGRATION_TONE: Record<string, Tone> = { mock: "warning", not_configured: "neutral", configured: "info", sandbox_tested: "info", production_verified: "success", error: "danger" };
const PROVIDER_NAME: Record<string, string> = { africastalking: "Africa's Talking", twilio: "Twilio", smtp: "SMTP", "mock-sms": "mock adapter", "mock-email": "mock adapter", sms: "no provider", email: "no provider" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("notifications.read");
  if (!allowed) return <Forbidden what="notifications" />;
  const sp = await searchParams;
  const tab = sp.tab === "templates" ? "templates" : sp.tab === "campaigns" ? "campaigns" : "messages";
  const canWrite = ctx.permissions.has("notifications.write");
  const tz = ctx.organization.timezone;
  const status = await messagingInUse(ctx.organizationId);

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="SMS and email sent to subscribers. Messages are marked simulated when a mock adapter is used, and skipped (never faked) when no provider is configured." />
      <div className="grid gap-4 sm:grid-cols-2">
        {(["sms", "email"] as const).map((ch) => (
          <Card key={ch}>
            <CardContent className="flex items-center justify-between py-4 text-sm">
              <span>
                <span className="font-medium uppercase">{ch}</span> <span className="text-muted-foreground">via {PROVIDER_NAME[status[ch].provider] ?? status[ch].provider}</span>
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
          { value: "campaigns", label: "Campaigns", href: "/notifications?tab=campaigns" },
        ]}
      />
      {tab === "messages" ? <Messages sp={sp} canWrite={canWrite} tz={tz} ctx={ctx} /> : tab === "campaigns" ? <Campaigns ctx={ctx} canWrite={canWrite} tz={tz} /> : <Templates ctx={ctx} canWrite={canWrite} />}
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

const CAMPAIGN_TONE: Record<string, Tone> = { DRAFT: "neutral", SCHEDULED: "info", SENDING: "warning", SENT: "success", CANCELLED: "neutral" };
const AUDIENCE_LABEL: Record<string, (v: string) => string> = {
  subscription: (v) => (v === "NONE" ? "no live plan" : `${v.toLowerCase()} subscription`),
  service: (v) => (v === "PPPOE" ? "PPPoE" : v === "HOTSPOT" ? "hotspot" : "static IP"),
  created: (v) => `joined in the last ${v.replace("d", " days")}`,
  vip: () => "VIP",
  risk: () => "at risk",
  routerId: () => "one router",
  packageId: () => "one plan",
};

async function Campaigns({ ctx, canWrite, tz }: { ctx: Parameters<typeof listCampaigns>[0]; canWrite: boolean; tz: string }) {
  const [rows, routers, packages] = await Promise.all([
    listCampaigns(ctx),
    canWrite && ctx.permissions.has("routers.read") ? routerNameOptions(ctx) : Promise.resolve([]),
    canWrite && ctx.permissions.has("packages.read") ? listPackages(ctx, { status: "ACTIVE" }) : Promise.resolve([]),
  ]);
  const pkgs = packages.map((p) => ({ id: p.id, name: p.name }));
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Campaigns</CardTitle>
          <CardDescription>Service notices to a chosen group of subscribers, or offers to those who agreed to receive them.</CardDescription>
        </div>
        {canWrite ? <CampaignDialog routers={routers} packages={pkgs} /> : null}
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState icon={Bell} title="No campaigns yet" description="Write a notice (for example about an outage), check who it reaches, then send it now or schedule it." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Campaign</Th>
              <Th>Audience</Th>
              <Th>Status</Th>
              <Th className="text-right">Recipients</Th>
              <Th className="text-right">Sent / failed / skipped</Th>
              {canWrite ? <Th className="text-right">Actions</Th> : null}
            </tr>
          </THead>
          <TBody>
            {rows.map((c) => {
              const filters = ((c.audience as { filters?: Record<string, string> } | null)?.filters ?? {}) as Record<string, string>;
              const audience = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => AUDIENCE_LABEL[k]?.(String(v)) ?? k);
              const draft: CampaignDraft = { id: c.id, name: c.name, channel: c.channel as CampaignDraft["channel"], kind: c.kind as CampaignDraft["kind"], subject: c.subject ?? "", body: c.body, audience: Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)])) };
              return (
                <Tr key={c.id}>
                  <Td label="Campaign">
                    <div className="min-w-0 text-right md:text-left">
                      <span className="font-medium">{c.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {c.channel === "SMS" ? "SMS" : "Email"} · {c.kind === "marketing" ? "Offer" : "Service notice"}
                      </span>
                      <span className="block max-w-md truncate text-xs text-muted-foreground" title={c.body}>
                        {c.body}
                      </span>
                    </div>
                  </Td>
                  <Td label="Audience" className="text-sm">
                    {audience.length ? audience.join(", ") : "All subscribers"}
                  </Td>
                  <Td label="Status">
                    <div className="min-w-0 text-right md:text-left">
                      <Badge tone={CAMPAIGN_TONE[c.status] ?? "neutral"}>{humanize(c.status)}</Badge>
                      {c.status === "SCHEDULED" && c.scheduledAt ? <span className="block text-xs text-muted-foreground">{formatDateTime(c.scheduledAt, tz)}</span> : null}
                      {c.completedAt && c.status !== "SCHEDULED" ? <span className="block text-xs text-muted-foreground">{formatDateTime(c.completedAt, tz)}</span> : null}
                    </div>
                  </Td>
                  <Td label="Recipients" className="tabular md:text-right">
                    {c.status === "DRAFT" || c.status === "SCHEDULED" ? "—" : c.recipients}
                  </Td>
                  <Td label="Sent / failed / skipped" className="tabular md:text-right">
                    {c.delivery.sent} / {c.delivery.failed} / {c.delivery.skipped}
                    {c.delivery.queued ? <span className="block text-xs text-muted-foreground">{c.delivery.queued} still queued</span> : null}
                  </Td>
                  {canWrite ? (
                    <Td label="Actions" className="md:text-right">
                      <span className="flex flex-wrap justify-end gap-1">
                        {c.status === "DRAFT" ? <CampaignDialog draft={draft} routers={routers} packages={pkgs} /> : null}
                        {c.status === "DRAFT" ? <SendCampaignDialog id={c.id} name={c.name} /> : null}
                        {["DRAFT", "SCHEDULED", "SENDING"].includes(c.status) ? <CancelCampaignButton id={c.id} name={c.name} /> : null}
                      </span>
                    </Td>
                  ) : null}
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
