import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { signupOpen } from "@/server/services/signup";
import { CloudlinkMark } from "@/components/shell/logo";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignupPage() {
  if (await resolveSession((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/dashboard");
  const open = signupOpen();

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -right-32 -top-32 size-[480px] rounded-full bg-accent/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-40 left-10 size-[420px] rounded-full bg-cyan/15 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <CloudlinkMark className="size-10" />
          <span className="text-lg font-semibold text-white">Cloudlink</span>
        </div>
        <div className="relative max-w-md space-y-4">
          <h1 className="text-3xl font-semibold leading-tight text-white">Start running your ISP on Cloudlink.</h1>
          <ul className="space-y-2 text-sm leading-relaxed text-sidebar-muted">
            <li>• Subscribers, plans and recurring invoices in KES</li>
            <li>• M-Pesa payments matched to the right account</li>
            <li>• MikroTik PPPoE and hotspot provisioning</li>
            <li>• A customer portal with your own branding</li>
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-muted">You become the owner of a new, empty workspace. Invite your team from Staff & Permissions.</p>
      </section>

      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center gap-3 lg:hidden">
            <CloudlinkMark />
            <span className="text-lg font-semibold">Cloudlink</span>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Create your account</h2>
            <p className="text-sm text-muted-foreground">For internet service providers. Customers of an ISP sign in through their provider&apos;s portal.</p>
          </div>
          {open ? (
            <SignupForm />
          ) : (
            <div className="space-y-3 text-sm">
              <p className="rounded-md border border-border bg-surface-muted px-3 py-2">New accounts are not open on this server. Contact the operator to get access.</p>
              <Link href="/login" className="font-medium text-accent hover:underline">
                Go to sign in
              </Link>
            </div>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Looking for your internet account?{" "}
            <Link href="/portal" className="text-accent hover:underline">
              Customer portal
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
