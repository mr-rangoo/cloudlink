import type { Metadata } from "next";
import Link from "next/link";
import { describeSignup } from "@/server/services/signup";
import { CloudlinkMark } from "@/components/shell/logo";
import { ConfirmSignup } from "./confirm";

export const metadata: Metadata = { title: "Confirm your account", referrer: "no-referrer" };

export default async function VerifySignupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const pending = token && token.length >= 20 && token.length <= 128 ? await describeSignup(token) : null;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-3">
          <CloudlinkMark />
          <span className="text-lg font-semibold">Cloudlink</span>
        </div>
        {pending && token ? (
          <>
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">Welcome, {pending.name.split(" ")[0]}</h1>
              <p className="text-sm text-muted-foreground">
                Your email {pending.email} is confirmed. Create the workspace for <strong>{pending.organizationName}</strong>; you will be its owner and can invite your team afterwards.
              </p>
            </div>
            <ConfirmSignup token={token} organizationName={pending.organizationName} />
          </>
        ) : (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold">This link is invalid or has expired</h1>
            <p className="text-sm text-muted-foreground">Links work once, for 24 hours. If you already confirmed it, sign in. Otherwise sign up again to get a new link.</p>
            <div className="flex gap-4 text-sm font-medium">
              <Link href="/login" className="text-accent hover:underline">
                Sign in
              </Link>
              <Link href="/signup" className="text-accent hover:underline">
                Sign up again
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
