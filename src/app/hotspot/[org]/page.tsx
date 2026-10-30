import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { brandingForSlug } from "@/server/services/branding";
import { portalPlans, safeRouterLoginUrl } from "@/server/services/hotspot-sales";
import { DefaultMode } from "@/components/brand";
import { cn } from "@/lib/utils";
import { templateById } from "@/lib/portal-templates";
import { PortalFrame } from "./frame";

export const metadata: Metadata = { title: "WiFi access", robots: { index: false } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Captive portal. The router's login page (served by Cloudlink, see hotspot-sales.routerLoginPage) redirects here with
 * ?router=<id>&mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only)&dst=$(link-orig). The router login happens
 * only after the server reports the plan active on the router.
 */
export default async function HotspotPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { org } = await params;
  if (!/^[a-z0-9-]{1,50}$/.test(org)) notFound();
  const organization = await brandingForSlug(org);
  if (!organization) notFound();
  const sp = await searchParams;
  const mac = sp.mac && /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(sp.mac) ? sp.mac.toUpperCase().replaceAll("-", ":") : null;
  const ip = sp.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(sp.ip) ? sp.ip : null;
  const routerParam = sp.router && UUID_RE.test(sp.router) ? sp.router : null;
  const portal = await portalPlans(org, routerParam);
  const loginUrl = safeRouterLoginUrl(sp["link-login-only"], portal.routerLoginHost);
  const dst = sp.dst && /^https?:\/\//.test(sp.dst) && sp.dst.length < 500 ? sp.dst : null;
  const template = templateById(portal.display.template);

  return (
    <main className={cn("flex min-h-dvh items-start justify-center px-4 py-8 sm:items-center", template.page)}>
      <style>{organization.css}</style>
      <DefaultMode mode={organization.defaultMode} />
      <PortalFrame
        template={template}
        orgName={organization.name}
        logoUrl={organization.logoUrl}
        headline={portal.support.welcome}
        steps={portal.display.steps}
        support={{ phone: portal.support.phone, whatsapp: portal.support.whatsapp, hours: portal.support.hours }}
        portal={{
          org,
          currency: portal.organization.currency,
          plans: portal.plans,
          routerId: portal.routerId,
          mac,
          ip,
          loginUrl,
          dst,
          mpesa: portal.payments.mpesa,
          testMode: portal.payments.testMode,
          showVouchers: portal.display.showVouchers,
          showReconnect: portal.display.showReconnect,
        }}
      />
    </main>
  );
}
