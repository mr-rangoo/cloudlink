import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { getSettings } from "@/server/services/admin";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { SettingsForm } from "./form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { ctx, allowed } = await getStaffContextWith("settings.write");
  if (!allowed) return <Forbidden what="organization settings" />;
  const s = await getSettings(ctx);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" description="Organization details and billing defaults. Changes are recorded in the audit log." />
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
    </div>
  );
}
