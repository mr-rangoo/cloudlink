import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { getSettings } from "@/server/services/admin";
import { brandingFor } from "@/server/services/branding";
import { instructionsFor, listPaymentMethods } from "@/server/services/payment-methods";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { getHotspotSettings } from "@/server/services/hotspot-settings";
import { portalPlans } from "@/server/services/hotspot-sales";
import { assistantSettings, assistantStatus } from "@/server/assistant/service";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { SettingsForm } from "./form";
import { BrandingForm } from "./branding-form";
import { PaymentMethodsPanel } from "./payment-methods-panel";
import { AssistantForm } from "./assistant-form";
import { HotspotSettingsForm } from "./hotspot-form";
import { OperatorAlertsForm } from "./operator-alerts-form";
import { getOperatorAlertSettings, OPERATOR_EVENT_LABEL, OPERATOR_EVENTS } from "@/server/services/operator-alerts";
import { SettingsNav, type SettingsNavGroup } from "./nav";
import { PaymentGatewaysCard } from "../integrations/gateways-card";
import { MpesaSettingsCard } from "../integrations/mpesa-card";
import { MessagingSettingsCard } from "../integrations/messaging-card";

export const metadata: Metadata = { title: "Settings" };

const NAV: SettingsNavGroup[] = [
  {
    group: "General",
    items: [
      { tab: "general", icon: "Building2", label: "Organization", hint: "Name, timezone, invoice numbers, tax" },
      { tab: "branding", icon: "Palette", label: "Branding", hint: "Logo, colours, light or dark" },
    ],
  },
  {
    group: "Network",
    items: [
      { tab: "hotspot", icon: "Wifi", label: "Hotspot", hint: "Captive portal, support contacts" },
      { href: "/routers", icon: "Router", label: "Routers", hint: "MikroTik routers and setup command" },
      { href: "/packages", icon: "Package", label: "Plans", hint: "Prices, speeds, schedules" },
    ],
  },
  {
    group: "Billing & messaging",
    items: [
      { tab: "gateways", icon: "CreditCard", label: "Payments", hint: "Payment gateways and credentials" },
      { tab: "payments", icon: "Wallet", label: "Payment methods", hint: "Paybill, till and bank shown to customers" },
      { tab: "messaging", icon: "MessageSquare", label: "Communications", hint: "SMS and email providers" },
      { href: "/notifications?tab=templates", icon: "FileText", label: "Message templates", hint: "Receipts, reminders, invites" },
    ],
  },
  {
    group: "Notifications",
    items: [{ tab: "alerts", icon: "Bell", label: "Operator alerts", hint: "Router status and daily summary" }],
  },
  {
    group: "Integrations",
    items: [
      { tab: "assistant", icon: "Bot", label: "AI assistant", hint: "Portal chat and Ask AI" },
      { href: "/integrations", icon: "Plug", label: "Integration status", hint: "Providers and test modes" },
    ],
  },
  {
    group: "Administration",
    items: [
      { href: "/staff", icon: "ShieldCheck", label: "Staff & permissions", hint: "Invite staff, roles" },
      { href: "/branches", icon: "Store", label: "Branches", hint: "Offices and their staff" },
      { href: "/audit-logs", icon: "ScrollText", label: "Audit log", hint: "Who changed what" },
    ],
  },
];

const TABS = ["general", "branding", "hotspot", "gateways", "payments", "messaging", "alerts", "assistant"] as const;
type Tab = (typeof TABS)[number];
const TITLES: Record<Tab, string> = {
  general: "Organization details",
  branding: "Branding and theme",
  hotspot: "Captive portal",
  gateways: "Payment gateways",
  payments: "Payment methods",
  messaging: "SMS and email",
  alerts: "Operator alerts",
  assistant: "AI assistant",
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("settings.write");
  if (!allowed) return <Forbidden what="organization settings" />;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "general";

  return (
    <div className="space-y-6">
      <div className="grid gap-8 lg:grid-cols-[16.5rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <SettingsNav groups={NAV} active={tab} />
        </aside>
        <div className="min-w-0 space-y-6">
          <PageHeader eyebrow={`Settings — ${TITLES[tab]}`} title={TITLES[tab]} description="Changes are recorded in the audit log." />
          {tab === "general" ? (
            <GeneralTab ctx={ctx} />
          ) : tab === "branding" ? (
            <BrandingTab ctx={ctx} />
          ) : tab === "hotspot" ? (
            <HotspotTab ctx={ctx} />
          ) : tab === "gateways" ? (
            <>
              <PaymentGatewaysCard ctx={ctx} />
              <MpesaSettingsCard ctx={ctx} />
            </>
          ) : tab === "payments" ? (
            <PaymentsTab ctx={ctx} />
          ) : tab === "messaging" ? (
            <MessagingSettingsCard ctx={ctx} />
          ) : tab === "alerts" ? (
            <AlertsTab ctx={ctx} />
          ) : (
            <AssistantTab ctx={ctx} />
          )}
        </div>
      </div>
    </div>
  );
}

type Ctx = Awaited<ReturnType<typeof getStaffContextWith>>["ctx"];

async function GeneralTab({ ctx }: { ctx: Ctx }) {
  const s = await getSettings(ctx);
  return (
    <SettingsForm
      initial={{
        name: s.organization.name,
        slug: s.organization.slug,
        currency: s.organization.currency,
        timezone: s.organization.timezone,
        billing: {
          legalName: s.billing.legalName ?? "",
          address: s.billing.address ?? "",
          phone: s.billing.phone ?? "",
          email: s.billing.email ?? "",
          taxPin: s.billing.taxPin ?? "",
          taxLabel: s.billing.taxLabel,
          invoicePrefix: s.billing.invoicePrefix,
          receiptPrefix: s.billing.receiptPrefix,
          creditNotePrefix: s.billing.creditNotePrefix,
          invoiceLeadDays: s.billing.invoiceLeadDays,
          expiryReminderDays: s.billing.expiryReminderDays,
          paymentTermsDays: s.billing.paymentTermsDays,
          invoiceOnActivation: s.billing.invoiceOnActivation,
          invoiceFooter: s.billing.invoiceFooter ?? "",
        },
      }}
      timezones={[...s.timezones]}
    />
  );
}

async function BrandingTab({ ctx }: { ctx: Ctx }) {
  const b = await brandingFor(ctx.organizationId);
  return (
    <BrandingForm
      organizationName={ctx.organization.name}
      initial={{ themePreset: b.themePreset, customAccent: b.customAccent, defaultMode: b.defaultMode, logoUrl: b.logoUrl, portalWelcome: b.portalWelcome, supportHours: b.supportHours }}
    />
  );
}

async function HotspotTab({ ctx }: { ctx: Ctx }) {
  const [settings, branding, portal, general] = await Promise.all([getHotspotSettings(ctx), brandingFor(ctx.organizationId), portalPlans(ctx.organization.slug, null), getSettings(ctx)]);
  return (
    <HotspotSettingsForm
      initial={settings}
      data={{
        slug: ctx.organization.slug,
        orgName: ctx.organization.name,
        logoUrl: branding.logoUrl,
        currency: ctx.organization.currency,
        plans: portal.plans,
        fallbackHeadline: branding.portalWelcome,
        fallbackPhone: general.billing.phone ?? null,
        hours: branding.supportHours,
        mpesa: portal.payments.mpesa,
      }}
    />
  );
}

async function PaymentsTab({ ctx }: { ctx: Ctx }) {
  const rows = await listPaymentMethods(ctx);
  return (
    <PaymentMethodsPanel
      stkMode={paymentAdapterMode()}
      methods={rows.map((m) => ({ id: m.id, kind: m.kind, label: m.label, details: (m.details ?? {}) as Record<string, string | null>, instructions: m.instructions, active: m.active, preview: instructionsFor(m, "A000123").lines }))}
    />
  );
}

async function AlertsTab({ ctx }: { ctx: Ctx }) {
  const settings = await getOperatorAlertSettings(ctx);
  return <OperatorAlertsForm initial={settings} events={OPERATOR_EVENTS.map((key) => ({ key, label: OPERATOR_EVENT_LABEL[key] }))} />;
}

async function AssistantTab({ ctx }: { ctx: Ctx }) {
  const settings = await assistantSettings(ctx.organizationId);
  return <AssistantForm initial={settings} status={assistantStatus()} organizationName={ctx.organization.name} />;
}
