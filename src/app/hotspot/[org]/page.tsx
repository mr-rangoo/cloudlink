import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Phone, Wifi } from "lucide-react";
import { brandingForSlug } from "@/server/services/branding";
import { portalPlans, safeRouterLoginUrl } from "@/server/services/hotspot-sales";
import { BrandMark, DefaultMode } from "@/components/brand";
import { HotspotPortal } from "./portal";

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

  return (
    <main className="flex min-h-dvh items-start justify-center bg-gradient-to-b from-sidebar to-sidebar-active px-4 py-8 sm:items-center">
      <style>{organization.css}</style>
      <DefaultMode mode={organization.defaultMode} />
      <div className="w-full max-w-md space-y-6 rounded-2xl bg-surface p-5 shadow-(--shadow-pop) sm:p-6">
        <header className="flex items-center gap-3">
          {organization.logoUrl ? (
            <BrandMark logoUrl={organization.logoUrl} className="size-11" />
          ) : (
            <div className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Wifi className="size-5" aria-hidden />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">{organization.name}</h1>
            <p className="text-sm text-muted-foreground">{portal.support.welcome ?? "Pick a plan, pay with M-Pesa, and you are online."}</p>
          </div>
        </header>
        <HotspotPortal
          org={org}
          currency={portal.organization.currency}
          plans={portal.plans}
          routerId={portal.routerId}
          mac={mac}
          ip={ip}
          loginUrl={loginUrl}
          dst={dst}
          mpesa={portal.payments.mpesa}
          testMode={portal.payments.testMode}
        />
        {portal.support.phone ? (
          <footer className="flex items-center justify-center gap-2 border-t border-border pt-4 text-sm text-muted-foreground">
            <Phone className="size-4" aria-hidden />
            Need help? Call{" "}
            <a className="font-medium text-accent hover:underline" href={`tel:${portal.support.phone.replace(/\s+/g, "")}`}>
              {portal.support.phone}
            </a>
            {portal.support.hours ? <span>· {portal.support.hours}</span> : null}
          </footer>
        ) : null}
      </div>
    </main>
  );
}
