import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { integrationStatus } from "@/server/services/integrations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { MpesaSettingsCard } from "./mpesa-card";
import { PaymentGatewaysCard } from "./gateways-card";
import { MessagingSettingsCard } from "./messaging-card";

export const metadata: Metadata = { title: "Integrations" };

const TONE: Record<string, Tone> = { ok: "success", production_verified: "success", sandbox_tested: "info", configured: "info", mock: "warning", not_configured: "neutral", unavailable: "danger", error: "danger" };
const LABEL: Record<string, string> = { ok: "Working", production_verified: "Production verified", sandbox_tested: "Sandbox tested", configured: "Configured, not yet tested", mock: "Mock (simulated)", not_configured: "Not configured", unavailable: "Unavailable", error: "Error" };

export default async function IntegrationsPage() {
  const { ctx, allowed } = await getStaffContextWith("integrations.read");
  if (!allowed) return <Forbidden what="integrations" />;
  const rows = await integrationStatus(ctx);
  const groups = ["payments", "network", "messaging", "infrastructure"] as const;
  return (
    <div className="space-y-6">
      <PageHeader title="Integrations" description="Live status of external providers and infrastructure. Nothing is marked tested or verified without a recorded real test." />
      {rows.some((r) => r.status === "mock") ? (
        <Alert tone="warning" title="Mock adapters active">
          Simulated adapters never move real money, change real routers or deliver real messages. They are rejected automatically when the app runs in production mode.
        </Alert>
      ) : null}
      {groups.map((g) => (
        <Card key={g}>
          <CardHeader>
            <CardTitle>{humanize(g)}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border p-0">
            {rows
              .filter((r) => r.category === g)
              .map((r) => (
                <div key={r.key} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.detail}
                      {r.phase ? ` (implementation phase ${r.phase})` : ""}
                    </p>
                  </div>
                  <Badge tone={TONE[r.status] ?? "neutral"}>{LABEL[r.status] ?? r.status}</Badge>
                </div>
              ))}
          </CardContent>
        </Card>
      ))}
      <PaymentGatewaysCard ctx={ctx} />
      <MpesaSettingsCard ctx={ctx} />
      <MessagingSettingsCard ctx={ctx} />
      <p className="text-xs text-muted-foreground">Credentials are stored encrypted (or as server environment secrets) and are never displayed after saving.</p>
    </div>
  );
}
