import type { StaffContext } from "@/server/auth/context";
import { listGateways } from "@/server/services/payment-gateways";
import { paymentAdapterMode } from "@/server/services/mpesa-config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, type Tone } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/utils";
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
        <ul className="divide-y divide-border rounded-md border border-border">
          {gateways.map((g) => {
            const [label, tone] = g.configured ? (STATUS[g.status] ?? [g.status, "neutral"]) : ["Not set up", "neutral" as Tone];
            return (
              <li key={g.key} className="space-y-2 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {g.name}
                      {g.active ? <Badge tone="success">Collecting online payments</Badge> : null}
                      <Badge tone={tone}>{label}</Badge>
                    </p>
                    <p className="text-sm text-muted-foreground">{g.summary}</p>
                    {g.key === "kopokopo" && kopokopo ? (
                      <p className="text-xs text-muted-foreground">
                        Till {kopokopo.tillNumber} · {kopokopo.environment === "production" ? "Production" : "Sandbox"}
                        {g.lastCheckedAt ? ` · last check ${formatDateTime(g.lastCheckedAt, tz)}` : ""}
                      </p>
                    ) : null}
                    {g.lastError ? <p className="text-xs text-danger">{g.lastError}</p> : null}
                  </div>
                  {canWrite ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {g.key === "kopokopo" ? <KopoKopoActions configured={g.configured} live={mode === "daraja"} current={{ environment: kopokopo?.environment ?? "sandbox", tillNumber: kopokopo?.tillNumber ?? "" }} /> : null}
                      {!g.active ? <UseGatewayButton provider={g.key} name={g.name} disabled={!g.configured} /> : null}
                    </div>
                  ) : null}
                </div>
                {g.key === "mpesa_daraja" ? <p className="text-xs text-muted-foreground">Set up below in M-Pesa settings.</p> : null}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          Payments are recorded only after the gateway confirms them: a signed or secret callback checked against the gateway&apos;s own status, and each M-Pesa receipt only once. Cash and bank payments are recorded by staff, and the instructions customers see are under Settings → Payment methods.
        </p>
      </CardContent>
    </Card>
  );
}
