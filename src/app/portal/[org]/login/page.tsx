import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brandingForSlug } from "@/server/services/branding";
import { BrandMark, DefaultMode } from "@/components/brand";
import { PortalLoginForm } from "./form";

export const metadata: Metadata = { title: "Sign in · Customer portal" };

export default async function PortalLogin({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ activated?: string }> }) {
  const { org } = await params;
  const { activated } = await searchParams;
  if (!/^[a-z0-9-]{1,50}$/.test(org)) notFound();
  const organization = await brandingForSlug(org);
  if (!organization) notFound();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
      <style>{organization.css}</style>
      <DefaultMode mode={organization.defaultMode} />
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-3">
          <BrandMark logoUrl={organization.logoUrl} />
          <div>
            <p className="text-lg font-semibold leading-tight">{organization.name}</p>
            <p className="text-xs text-muted-foreground">Customer portal</p>
          </div>
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-muted-foreground">Use your phone number or account number.</p>
        </div>
        {activated ? (
          <p role="status" className="rounded-md border border-success/20 bg-success-soft px-3 py-2 text-sm text-success">
            Your password is set. Sign in to continue.
          </p>
        ) : null}
        <PortalLoginForm organization={org} />
        <p className="text-center text-xs text-muted-foreground">
          First time? Use the setup link sent by {organization.name}. Not your provider?{" "}
          <Link href="/portal?provider=" className="text-accent hover:underline">
            Change provider
          </Link>
        </p>
      </div>
    </main>
  );
}
