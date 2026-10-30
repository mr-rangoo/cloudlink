import type { StaffContext } from "@/server/auth/context";
import { listGateways } from "@/server/services/payment-gateways";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, type Tone } from "@/components/ui/feedback";
import Link from "next/link";
import { cn, formatDateTime } from "@/lib/utils";
import { KopoKopoActions, UseGatewayButton } from "./gateways-client";

const STATUS: Record<string, [string, Tone]> = {
  NOT_CONFIGURED: ["Not tested yet", "neutral"],
  SANDBOX_TESTED: ["Sandbox tested", "info"],
  PRODUCTION_VERIFIED: ["Production verified", "success"],
  ERROR: ["Error", "danger"],
};

/** Payment gateway catalogue: which configured gateway collects online payments. */
export async function PaymentGatewaysCard({ ctx }: { ctx: StaffContext }) {
  const { gateways, kopokopo } = await listGateways(ctx);
  const mode = paymentAdapterMode();
  const canWrite = ctx.permissions.has("integrations.write");
  const tz = ctx.organization.timezone;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment gateways</CardTitle>
        <CardDescription>
          Set up one or more gateways and choose which one collects online payments (portal &ldquo;Pay with M-Pesa&rdquo;, staff payment requests, hotspot sales). Requests already sent finish on the gateway that sent them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {mode === "mock" ? (
          <Alert tone="warning">Test mode (PAYMENT_ADAPTER=mock): payments are simulated whichever gateway is chosen.</Alert>
        ) : mode === "disabled" ? (
          <Alert tone="info">Online payment is disabled for this deployment (PAYMENT_ADAPTER=disabled).</Alert>
        ) : null}
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {gateways.length + 1} ways to get paid <span className="text-accent">· {gateways.filter((g) => g.configured).length} set up</span>
        </p>
        <ul className="grid gap-3 md:grid-cols-2">
          {gateways.map((g) => {
            const [label, tone] = g.configured ? (STATUS[g.status] ?? [g.status, "neutral"]) : ["Not set up", "neutral" as Tone];
            return (
              <li key={g.key} className={cn("flex flex-col gap-3 rounded-2xl border p-4", g.active ? "border-accent/60 bg-accent-soft/40" : "border-border bg-surface")}>
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-sm font-bold text-accent" aria-hidden>
                    {g.key === "mpesa_daraja" ? "M" : "K"}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {g.name}
                      {g.active ? <Badge tone="success">Collecting online payments</Badge> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{g.key === "mpesa_daraja" ? "Safaricom · Kenya" : "Kopo Kopo · Kenya"}</p>
                  </div>
                  <Badge tone={tone}>{label}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{g.summary}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.features.map((f) => (
                    <span key={f} className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium">
                      {f}
                    </span>
                  ))}
                </div>
                {g.key === "kopokopo" && kopokopo ? (
                  <p className="text-xs text-muted-foreground">
                    Till {kopokopo.tillNumber} · {kopokopo.environment === "production" ? "Production" : "Sandbox"}
                    {g.lastCheckedAt ? ` · last check ${formatDateTime(g.lastCheckedAt, tz)}` : ""}
                  </p>
                ) : null}
                {g.lastError ? <p className="text-xs text-danger">{g.lastError}</p> : null}
                {canWrite ? (
                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    {g.key === "kopokopo" ? (
                      <KopoKopoActions configured={g.configured} live={mode === "daraja"} current={{ environment: kopokopo?.environment ?? "sandbox", tillNumber: kopokopo?.tillNumber ?? "" }} />
                    ) : (
                      <span className="text-xs text-muted-foreground">Set up in M-Pesa settings below</span>
                    )}
                    {!g.active ? (
                      <span className="ml-auto">
                        <UseGatewayButton provider={g.key} name={g.name} disabled={!g.configured} />
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
          <li className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-sm font-bold text-accent" aria-hidden>
                B
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-semibold">Cash and bank</p>
                <p className="text-xs text-muted-foreground">Built in · always available</p>
              </div>
              <Badge tone="success">Ready</Badge>
            </div>
            <p className="text-sm text-muted-foreground">Staff record cash, bank and cheque payments. Customers see your paybill, till and bank details on invoices and in the portal.</p>
            <div className="mt-auto border-t border-border pt-3">
              <Link href="/settings?tab=payments" className="text-xs font-medium text-accent hover:underline">
                Edit what customers see →
              </Link>
            </div>
          </li>
        </ul>
        <p className="text-xs text-muted-foreground">
          Payments are recorded only after the gateway confirms them: a signed or secret callback checked against the gateway&apos;s own status, and each M-Pesa receipt only once. Cash and bank payments are recorded by staff, and the instructions customers see are under Settings → Payment methods.
        </p>
      </CardContent>
    </Card>
  );
}
