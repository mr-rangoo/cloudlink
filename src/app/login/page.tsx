import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { CloudlinkMark } from "@/components/shell/logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string; next?: string }> }) {
  const session = await resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
  const params = await searchParams;
  if (session && params.reason !== "access") redirect("/dashboard");

  // Only allow same-site relative redirects after login.
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/dashboard";

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
          <h1 className="text-3xl font-semibold leading-tight text-white">Billing, payments and network operations for growing ISPs.</h1>
          <p className="text-sm leading-relaxed text-sidebar-muted">
            Manage subscribers, recurring invoices, M-Pesa and bank reconciliation, and MikroTik provisioning from one auditable workspace.
          </p>
        </div>
        <p className="relative text-xs text-sidebar-muted">Africa/Nairobi · KES</p>
      </section>

      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center gap-3 lg:hidden">
            <CloudlinkMark />
            <span className="text-lg font-semibold">Cloudlink</span>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">Use your staff account to access your organization.</p>
          </div>
          {params.reason === "access" ? (
            <p role="alert" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
              Your access to the selected organization is no longer active. Sign in again.
            </p>
          ) : null}
          <LoginForm next={next} />
        </div>
      </section>
    </div>
  );
}
