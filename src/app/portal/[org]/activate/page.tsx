import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { brandingForSlug } from "@/server/services/branding";
import { BrandMark, DefaultMode } from "@/components/brand";
import { ActivateForm } from "./form";

export const metadata: Metadata = { title: "Set up your account · Customer portal", referrer: "no-referrer" };

export default async function ActivatePage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ token?: string }> }) {
  const { org } = await params;
  const { token } = await searchParams;
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
          <h1 className="text-2xl font-semibold tracking-tight">Set your password</h1>
          <p className="text-sm text-muted-foreground">You will use it with your phone number or account number to sign in.</p>
        </div>
        {token ? <ActivateForm token={token} organization={org} /> : <p className="text-sm text-danger">This link is incomplete. Open the full link from your message.</p>}
      </div>
    </main>
  );
}
