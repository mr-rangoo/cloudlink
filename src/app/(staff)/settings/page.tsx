import type { Metadata } from "next";
import Link from "next/link";
import { getStaffContextWith } from "@/server/auth/page";
import { getSettings } from "@/server/services/admin";
import { brandingFor } from "@/server/services/branding";
import { instructionsFor, listPaymentMethods } from "@/server/services/payment-methods";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/feedback";
import { FilterTabs } from "@/components/list-toolbar";
import { Forbidden } from "@/components/shell/forbidden";
import { SettingsForm } from "./form";
import { BrandingForm } from "./branding-form";
import { PaymentMethodsPanel } from "./payment-methods-panel";
import { AssistantForm } from "./assistant-form";
import { assistantSettings, assistantStatus } from "@/server/assistant/service";

export const metadata: Metadata = { title: "Settings" };

const TABS = [
  ["general", "General"],
  ["branding", "Branding & theme"],
  ["payments", "Payment methods"],
  ["assistant", "AI assistant"],
] as const;
type Tab = (typeof TABS)[number][0];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("settings.write");
  if (!allowed) return <Forbidden what="organization settings" />;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.some(([t]) => t === rawTab) ? (rawTab as Tab) : "general";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Settings" description="Organization details, billing defaults, look and feel, how customers pay, and the portal assistant. Changes are recorded in the audit log." />
      <FilterTabs label="Settings sections" active={tab} items={TABS.map(([t, label]) => ({ value: t, label, href: t === "general" ? "/settings" : `/settings?tab=${t}` }))} />
      {tab === "general" ? <GeneralTab ctx={ctx} /> : tab === "branding" ? <BrandingTab ctx={ctx} /> : tab === "payments" ? <PaymentsTab ctx={ctx} /> : <AssistantTab ctx={ctx} />}
      <Card>
        <CardContent className="flex flex-wrap gap-x-5 gap-y-2 py-4 text-sm">
          <span className="text-muted-foreground">More settings:</span>
          <Link href="/integrations" className="text-accent hover:underline">
            Integrations (M-Pesa, SMS, email)
          </Link>
          <Link href="/notifications" className="text-accent hover:underline">
            Message templates
          </Link>
          <Link href="/staff" className="text-accent hover:underline">
            Staff & permissions
          </Link>
          <Link href="/branches" className="text-accent hover:underline">
            Branches
          </Link>
          <Link href="/routers" className="text-accent hover:underline">
            Routers
          </Link>
        </CardContent>
      </Card>
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

async function PaymentsTab({ ctx }: { ctx: Ctx }) {
  const rows = await listPaymentMethods(ctx);
  return (
    <PaymentMethodsPanel
      stkMode={paymentAdapterMode()}
      methods={rows.map((m) => ({ id: m.id, kind: m.kind, label: m.label, details: (m.details ?? {}) as Record<string, string | null>, instructions: m.instructions, active: m.active, preview: instructionsFor(m, "A000123").lines }))}
    />
  );
}

async function AssistantTab({ ctx }: { ctx: Ctx }) {
  const settings = await assistantSettings(ctx.organizationId);
  return <AssistantForm initial={settings} status={assistantStatus()} organizationName={ctx.organization.name} />;
}
