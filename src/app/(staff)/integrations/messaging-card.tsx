import { getMessagingSettings } from "@/server/services/messaging-config";
import type { StaffContext } from "@/server/auth/context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { formatDateTime, formatMoney } from "@/lib/utils";
import { BalanceButton, ConfirmReceivedButton, EmailSettingsDialog, SmsSettingsDialog, TestMessageDialog } from "./messaging-client";

const PROVIDER: Record<string, string> = { africastalking: "Africa's Talking", twilio: "Twilio", smtp: "SMTP", "mock-sms": "Mock adapter", "mock-email": "Mock adapter", sms: "None", email: "None" };
const SOURCE: Record<string, string> = { integration: "saved in Cloudlink", environment: "server environment", mock: "simulated", none: "not configured" };
const STATUS: Record<string, { label: string; tone: "success" | "info" | "neutral" | "danger" }> = {
  PRODUCTION_VERIFIED: { label: "Verified", tone: "success" },
  SANDBOX_TESTED: { label: "Sandbox tested", tone: "info" },
  NOT_CONFIGURED: { label: "Not verified", tone: "neutral" },
  ERROR: { label: "Error", tone: "danger" },
};

type Test = { at: string; to: string; accepted: boolean; simulated: boolean; error: string | null; confirmedAt: string | null } | null;

function TestLine({ test, tz }: { test: Test; tz: string }) {
  if (!test) return <p className="text-xs text-muted-foreground">No test message sent yet.</p>;
  return (
    <p className="text-xs text-muted-foreground">
      Last test to {test.to} on {formatDateTime(test.at, tz)}:{" "}
      {test.accepted ? (test.simulated ? "simulated (mock adapter)." : test.confirmedAt ? `accepted, and confirmed received ${formatDateTime(test.confirmedAt, tz)}.` : "accepted by the provider (not yet confirmed received).") : `not accepted — ${test.error ?? "unknown error"}.`}
    </p>
  );
}

/** SMS and email providers for this organization: settings, test message, arrival confirmation, SMS balance. */
export async function MessagingSettingsCard({ ctx }: { ctx: StaffContext }) {
  const s = await getMessagingSettings(ctx);
  const canWrite = ctx.permissions.has("integrations.write");
  const tz = ctx.organization.timezone;
  const live = s.mode === "live";
  const sms = s.sms;
  const email = s.email;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Messaging providers</CardTitle>
        <CardDescription>Your own SMS and email accounts. Credentials are encrypted and cannot be viewed after saving. A provider counts as verified only after a test message is accepted and you confirm it arrived.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {s.mode === "mock" ? (
          <Alert tone="warning" title="Mock messaging">
            MESSAGING_ADAPTER=mock: messages are simulated and never delivered, whatever is saved here. Saved settings take effect when the deployment uses MESSAGING_ADAPTER=live.
          </Alert>
        ) : s.mode === "disabled" ? (
          <Alert tone="warning" title="Messaging disabled">
            MESSAGING_ADAPTER=disabled: every message is skipped.
          </Alert>
        ) : null}

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">SMS</h3>
              <p className="text-xs text-muted-foreground">
                In use: {PROVIDER[sms.inUse.provider] ?? sms.inUse.provider} ({SOURCE[sms.inUse.source] ?? sms.inUse.source})
                {sms.provider ? ` · Saved: ${PROVIDER[sms.provider]}${sms.provider === "africastalking" ? ` (${sms.username}${sms.senderId ? `, sender ${sms.senderId}` : ""})` : ` (${sms.from})`}${sms.enabled ? "" : ", switched off"}` : ""}
              </p>
            </div>
            {sms.provider ? <Badge tone={STATUS[sms.status]?.tone ?? "neutral"}>{STATUS[sms.status]?.label ?? sms.status}</Badge> : <Badge tone="neutral">Not set up</Badge>}
          </div>
          <TestLine test={sms.lastTest} tz={tz} />
          {sms.lastBalance ? (
            <p className="text-xs text-muted-foreground">
              Balance {formatMoney(sms.lastBalance.amount, sms.lastBalance.currency)} at {formatDateTime(sms.lastBalance.at, tz)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canWrite ? (
              <SmsSettingsDialog
                current={{ provider: sms.provider ?? "africastalking", username: sms.username ?? "", senderId: sms.senderId ?? "", accountSid: sms.accountSid ?? "", from: sms.from ?? "", enabled: sms.provider ? sms.enabled : true, credentialsSet: sms.credentialsSet }}
              />
            ) : null}
            {canWrite && sms.inUse.available ? <TestMessageDialog channel="SMS" /> : null}
            {canWrite && live && sms.lastTest?.accepted && !sms.lastTest.simulated && !sms.lastTest.confirmedAt && sms.inUse.source === "integration" ? <ConfirmReceivedButton channel="SMS" /> : null}
            {live && sms.balanceSupported ? <BalanceButton /> : null}
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Email</h3>
              <p className="text-xs text-muted-foreground">
                In use: {PROVIDER[email.inUse.provider] ?? email.inUse.provider} ({SOURCE[email.inUse.source] ?? email.inUse.source})
                {email.host ? ` · Saved: ${email.host}:${email.port} (${email.security === "ssl" ? "SSL" : email.security === "starttls" ? "STARTTLS" : "no encryption"}), from ${email.fromAddress}${email.enabled ? "" : ", switched off"}` : ""}
              </p>
            </div>
            {email.host ? <Badge tone={STATUS[email.status]?.tone ?? "neutral"}>{STATUS[email.status]?.label ?? email.status}</Badge> : <Badge tone="neutral">Not set up</Badge>}
          </div>
          <TestLine test={email.lastTest} tz={tz} />
          <div className="flex flex-wrap gap-2">
            {canWrite ? (
              <EmailSettingsDialog
                current={{ host: email.host ?? "", port: email.port ?? 587, security: email.security ?? "starttls", username: email.username ?? "", fromAddress: email.fromAddress ?? "", fromName: email.fromName ?? "", enabled: email.host ? email.enabled : true, passwordSet: email.passwordSet }}
              />
            ) : null}
            {canWrite && email.inUse.available ? <TestMessageDialog channel="EMAIL" /> : null}
            {canWrite && live && email.lastTest?.accepted && !email.lastTest.simulated && !email.lastTest.confirmedAt && email.inUse.source === "integration" ? <ConfirmReceivedButton channel="EMAIL" /> : null}
          </div>
        </section>
        <p className="text-xs text-muted-foreground">WhatsApp is not available yet: business messages need a verified Meta business account and approved templates.</p>
      </CardContent>
    </Card>
  );
}
