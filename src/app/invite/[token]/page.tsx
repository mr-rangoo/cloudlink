import type { Metadata } from "next";
import Link from "next/link";
import { describeStaffInvite } from "@/server/services/admin";
import { CloudlinkMark } from "@/components/shell/logo";
import { InviteForm } from "./form";

export const metadata: Metadata = { title: "Set your password", referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = token.length >= 20 && token.length <= 128 ? await describeStaffInvite(decodeURIComponent(token)) : null;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-3">
          <CloudlinkMark />
          <span className="text-lg font-semibold">Cloudlink</span>
        </div>
        {invite ? (
          <>
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">{invite.purpose === "setup" ? `Welcome, ${invite.name.split(" ")[0]}` : "Reset your password"}</h1>
              <p className="text-sm text-muted-foreground">
                {invite.purpose === "setup" ? `Set a password to join ${invite.organization}.` : `Choose a new password for ${invite.email}. You will be signed out everywhere.`}
              </p>
            </div>
            <InviteForm token={decodeURIComponent(token)} email={invite.email} />
          </>
        ) : (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold">This link is invalid or has expired</h1>
            <p className="text-sm text-muted-foreground">Ask your administrator for a new link.</p>
            <Link href="/login" className="text-sm font-medium text-accent hover:underline">
              Go to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
