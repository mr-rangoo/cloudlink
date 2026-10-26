import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Wifi } from "lucide-react";
import { brandingForSlug } from "@/server/services/branding";
import { BrandMark, DefaultMode } from "@/components/brand";
import { HotspotForm } from "./form";

export const metadata: Metadata = { title: "WiFi access", robots: { index: false } };

/**
 * Captive portal. A MikroTik hotspot login page can redirect here with ?mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only)&dst=$(link-orig).
 * The router login itself happens only after the voucher is confirmed and the hotspot user is provisioned.
 */
export default async function HotspotPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { org } = await params;
  if (!/^[a-z0-9-]{1,50}$/.test(org)) notFound();
  const organization = await brandingForSlug(org);
  if (!organization) notFound();
  const sp = await searchParams;
  const mac = sp.mac && /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(sp.mac) ? sp.mac.toUpperCase() : null;
  const ip = sp.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(sp.ip) ? sp.ip : null;
  // Only accept a router login URL on a private/link-local address, never an arbitrary external site.
  const loginUrl = sp["link-login-only"] && /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+(:\d+)?\/login$/.test(sp["link-login-only"]) ? sp["link-login-only"] : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-sidebar to-sidebar-active px-5 py-10">
      <style>{organization.css}</style>
      <DefaultMode mode={organization.defaultMode} />
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-surface p-6 shadow-(--shadow-pop)">
        <div className="flex items-center gap-3">
          {organization.logoUrl ? (
            <BrandMark logoUrl={organization.logoUrl} className="size-11" />
          ) : (
            <div className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Wifi className="size-5" aria-hidden />
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold leading-tight">{organization.name}</h1>
            <p className="text-sm text-muted-foreground">Enter your voucher code to get online</p>
          </div>
        </div>
        <HotspotForm org={org} mac={mac} ip={ip} loginUrl={loginUrl} />
        <p className="text-center text-xs text-muted-foreground">Buy vouchers from {organization.name} or an authorised agent. Online purchase is not available yet.</p>
      </div>
    </main>
  );
}
