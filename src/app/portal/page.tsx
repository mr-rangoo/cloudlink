import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CloudlinkMark } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { PORTAL_ORG_COOKIE } from "@/server/portal/page";
import { PORTAL_COOKIE, resolveCustomerContext } from "@/server/portal/auth";

export const metadata: Metadata = { title: "Customer portal" };

/** Portal entry: resume the customer's session, or send them to their provider's sign-in page. */
export default async function PortalEntry({ searchParams }: { searchParams: Promise<{ provider?: string }> }) {
  const c = await cookies();
  const ctx = await resolveCustomerContext(c.get(PORTAL_COOKIE)?.value, { correlationId: crypto.randomUUID(), ipAddress: null, userAgent: null });
  if (ctx) redirect("/portal/home");
  const sp = await searchParams;
  // An explicit ?provider= (even empty, from "Change provider") overrides the remembered provider.
  const provider = (sp.provider !== undefined ? sp.provider : (c.get(PORTAL_ORG_COOKIE)?.value ?? "")).trim().toLowerCase();
  if (provider && /^[a-z0-9-]{1,50}$/.test(provider)) redirect(`/portal/${provider}/login`);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-3">
          <CloudlinkMark />
          <span className="text-lg font-semibold">Customer portal</span>
        </div>
        <p className="text-sm text-muted-foreground">Enter the provider code from your invoice or invite message.</p>
        <form method="get" action="/portal" className="space-y-4">
          <Field id="provider" label="Provider code">
            <Input name="provider" autoCapitalize="none" autoComplete="organization" placeholder="e.g. skyline-demo" />
          </Field>
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
      </div>
    </main>
  );
}
