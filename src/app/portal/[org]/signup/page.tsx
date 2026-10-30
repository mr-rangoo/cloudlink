import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brandingForSlug } from "@/server/services/branding";
import { signupPlans } from "@/server/portal/signup";
import { BrandMark, DefaultMode } from "@/components/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInterval } from "@/components/status";
import { formatMoney } from "@/lib/utils";
import { ServiceRequestForm, SetupLinkForm } from "./forms";

export const metadata: Metadata = { title: "Sign up · Customer portal" };

export default async function PortalSignup({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  if (!/^[a-z0-9-]{1,50}$/.test(org)) notFound();
  const organization = await brandingForSlug(org);
  if (!organization) notFound();
  const plans = await signupPlans(organization.organizationId);

  return (
    <main className="flex min-h-dvh justify-center bg-background px-6 py-12">
      <style>{organization.css}</style>
      <DefaultMode mode={organization.defaultMode} />
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-3">
          <BrandMark logoUrl={organization.logoUrl} />
          <div>
            <p className="text-lg font-semibold leading-tight">{organization.name}</p>
            <p className="text-xs text-muted-foreground">Customer portal</p>
          </div>
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sign up</h1>
          <p className="text-sm text-muted-foreground">New to {organization.name}? Request a connection. Already connected? Get a link to set your password.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>New customer</CardTitle>
            <CardDescription>Tell us where you need internet and we will get in touch to install it.</CardDescription>
          </CardHeader>
          <CardContent>
            <ServiceRequestForm
              organization={org}
              provider={organization.name}
              plans={plans.map((p) => ({ id: p.id, label: `${p.name} · ${formatMoney(p.price.toString(), p.currency)} ${formatInterval(p.billingUnit, p.billingCount)}${p.highlight === "POPULAR" ? " · Popular" : p.highlight === "OFFER" ? " · On offer" : ""}` }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Already a customer?</CardTitle>
            <CardDescription>Never set a portal password, or forgot it? We will send a link to the phone or email on your account.</CardDescription>
          </CardHeader>
          <CardContent>
            <SetupLinkForm organization={org} />
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Have a password?{" "}
          <Link href={`/portal/${org}/login`} className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
