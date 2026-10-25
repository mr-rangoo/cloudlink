import type { StaffContext } from "@/server/auth/context";
import { getMpesaSettings } from "@/server/services/mpesa-config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/utils";
import { MpesaActions } from "./mpesa-client";

/** M-Pesa (Daraja) settings for this organization. Credentials are write-only. */
export async function MpesaSettingsCard({ ctx }: { ctx: StaffContext }) {
  const s = await getMpesaSettings(ctx);
  const tz = ctx.organization.timezone;
  const canWrite = ctx.permissions.has("integrations.write");
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>M-Pesa settings</CardTitle>
          <CardDescription>Your organization&apos;s paybill or till and Daraja app. Customers pay by STK Push or directly to the paybill/till.</CardDescription>
        </div>
        {canWrite ? (
          <MpesaActions
            mode={s.mode}
            configured={s.credentialsSet}
            source={s.source}
            current={{ environment: s.environment ?? "sandbox", type: s.type ?? "PAYBILL", shortcode: s.shortcode ?? "", tillNumber: s.tillNumber ?? "", rejectUnknownAccounts: s.rejectUnknownAccounts }}
          />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {s.mode === "mock" ? (
          <Alert tone="warning">The mock payment adapter is active (PAYMENT_ADAPTER=mock). Requests are simulated and these settings are not used.</Alert>
        ) : s.mode === "disabled" ? (
          <Alert tone="info">Online payment is disabled for this deployment (PAYMENT_ADAPTER=disabled).</Alert>
        ) : null}
        <dl className="divide-y divide-border">
          {row("Credentials", s.credentialsSet ? (s.source === "environment" ? "From the server environment" : "Saved (encrypted)") : "Not set")}
          {row("Environment", s.environment ? (s.environment === "production" ? "Production" : "Sandbox") : "—")}
          {row("Type", s.type ? (s.type === "TILL" ? `Till ${s.tillNumber ?? ""} (store ${s.shortcode})` : `Paybill ${s.shortcode}`) : "—")}
          {row("Last credential check", s.lastCheckedAt ? formatDateTime(s.lastCheckedAt, tz) : "Never")}
          {s.lastError ? row("Last error", <span className="text-danger">{s.lastError}</span>) : null}
          {row("Direct paybill/till payments (C2B)", s.c2bRegisteredAt ? `URLs registered ${formatDateTime(s.c2bRegisteredAt, tz)}` : "Not registered")}
          {row("Unknown account references", s.rejectUnknownAccounts ? "Rejected at validation" : "Accepted, then reconciled")}
        </dl>
        {s.c2bUrls ? (
          <div className="space-y-1 rounded-md border border-border p-3 text-xs">
            <p className="font-medium">C2B URLs (keep private: they contain a secret token)</p>
            <p className="break-all font-mono text-muted-foreground">{s.c2bUrls.confirmationUrl}</p>
            <p className="break-all font-mono text-muted-foreground">{s.c2bUrls.validationUrl}</p>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          STK callbacks go to {s.callbackBase || "APP_URL"}/api/v1/webhooks/mobile-money/… with a secret token per request. Payments are recorded only after M-Pesa confirms them with a status query; a browser redirect never counts.
        </p>
      </CardContent>
    </Card>
  );
}
