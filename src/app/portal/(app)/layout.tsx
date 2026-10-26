import { getCustomerContext } from "@/server/portal/page";
import { cookies } from "next/headers";
import { brandingFor } from "@/server/services/branding";
import { DefaultMode } from "@/components/brand";
import { assistantSettings } from "@/server/assistant/service";
import { assistantAdapterName } from "@/server/assistant/model";
import { PortalNav } from "./nav";

export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCustomerContext();
  const [branding, assistant] = await Promise.all([brandingFor(ctx.organizationId), assistantSettings(ctx.organizationId)]);
  const saved = (await cookies()).get("cloudlink_theme")?.value;
  const mode = saved === "light" || saved === "dark" || saved === "system" ? saved : branding.defaultMode;
  return (
    <div className="min-h-dvh bg-background">
      <style>{branding.css}</style>
      <DefaultMode mode={branding.defaultMode} />
      <PortalNav organization={ctx.organization.name} customer={ctx.displayName} logoUrl={branding.logoUrl} mode={mode} assistant={assistant.enabled && assistantAdapterName() !== "disabled" ? assistant.name : null} />
      <main id="main" className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-4xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">{branding.supportHours ? `Support: ${branding.supportHours} · ` : ""}Powered by Cloudlink · Your data is visible only to you and {ctx.organization.name}.</footer>
    </div>
  );
}
