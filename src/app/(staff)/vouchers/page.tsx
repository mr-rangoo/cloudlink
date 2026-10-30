import type { Metadata } from "next";
import Link from "next/link";
import { Ticket } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listAgents, listBatches, redemptionStats } from "@/server/services/vouchers";
import { listPackages } from "@/server/services/packages";
import { routerOptions } from "@/server/services/routers";
import { describeInterval } from "@/server/domain/billing-period";
import { formatPhone } from "@/server/domain/contact";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { FilterTabs } from "@/components/list-toolbar";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatMoney } from "@/lib/utils";
import { AgentDialog, GenerateBatchDialog, RemittanceDialog, StaffRedeemForm } from "./client";

export const metadata: Metadata = { title: "Vouchers" };

export default async function VouchersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("vouchers.read");
  if (!allowed) return <Forbidden what="vouchers" />;
  const sp = await searchParams;
  const tab = sp.tab === "agents" ? "agents" : sp.tab === "redeem" ? "redeem" : "batches";
  const canWrite = ctx.permissions.has("vouchers.write");
  const [batches, agents, stats, packages] = await Promise.all([
    listBatches(ctx),
    listAgents(ctx),
    redemptionStats(ctx),
    canWrite && ctx.permissions.has("packages.read") ? listPackages(ctx, { status: "ACTIVE" }) : Promise.resolve([]),
  ]);
  const hotspotRouters = canWrite && ctx.permissions.has("routers.read") ? await routerOptions(ctx, "hotspot") : [];
  const cur = ctx.organization.currency;
  const tz = ctx.organization.timezone;
  const portalUrl = `${process.env.APP_URL ?? ""}/hotspot/${ctx.organization.slug}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Hotspot vouchers"
        description="Hotspot voucher batches, resellers and redemptions."
        actions={canWrite && tab === "batches" ? <GenerateBatchDialog packages={packages.map((p) => ({ id: p.id, label: `${p.name} — ${describeInterval(p.billingUnit, p.billingCount)} · ${formatMoney(p.price.toString(), p.currency)} + tax` }))} agents={agents.agents.filter((a) => a.status === "ACTIVE").map((a) => ({ id: a.id, name: a.name }))} routers={hotspotRouters.map((r) => ({ id: r.id, name: r.name }))} canExport={ctx.permissions.has("vouchers.export")} /> : canWrite && tab === "agents" ? <AgentDialog /> : null}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">Redemptions (30 days)</p>
            <p className="text-xl font-semibold">{stats.last30Days.redemptions}</p>
            <p className="text-xs text-muted-foreground">{formatMoney(stats.last30Days.value, cur)} face value</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">Network activation</p>
            <p className="text-sm">
              {Object.entries(stats.activation).length ? Object.entries(stats.activation).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join(" · ") : "No redemptions yet"}
            </p>
            <p className="text-xs text-muted-foreground">Simulated = mock adapter, no router change</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">Captive portal URL</p>
            <p className="break-all font-mono text-xs">{portalUrl}</p>
            <p className="text-xs text-muted-foreground">Point the hotspot login page here</p>
          </CardContent>
        </Card>
      </div>
      <FilterTabs
        label="Vouchers view"
        active={tab}
        items={[
          { value: "batches", label: "Batches", count: batches.length, href: "/vouchers" },
          { value: "agents", label: "Agents", count: agents.agents.length, href: "/vouchers?tab=agents" },
          ...(canWrite ? [{ value: "redeem", label: "Redeem for a customer", href: "/vouchers?tab=redeem" }] : []),
        ]}
      />
      {tab === "batches" ? (
        <Card>
          {batches.length === 0 ? (
            <EmptyState icon={Ticket} title="No voucher batches" description={canWrite ? "Generate a batch from a hotspot package to print and sell vouchers." : undefined} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Batch</Th>
                  <Th>Package</Th>
                  <Th>Agent</Th>
                  <Th className="text-right">Face value</Th>
                  <Th className="text-right">Unused / redeemed</Th>
                  <Th>Expires</Th>
                  <Th>Status</Th>
                </tr>
              </THead>
              <TBody>
                {batches.map((b) => (
                  <Tr key={b.id}>
                    <Td label="Batch" className="font-mono text-xs">
                      <Link href={`/vouchers/batches/${b.id}`} className="text-accent hover:underline">
                        {b.batchNumber}
                      </Link>
                    </Td>
                    <Td label="Package">
                      {b.packageName} <span className="text-xs text-muted-foreground">· {describeInterval(b.durationUnit, b.durationCount)}</span>
                    </Td>
                    <Td label="Agent">{b.agentName ?? <span className="text-muted-foreground">Direct</span>}</Td>
                    <Td label="Face value" className="tabular md:text-right">
                      {formatMoney(b.faceValue.toString(), b.currency)}
                    </Td>
                    <Td label="Unused / redeemed" className="tabular md:text-right">
                      {b.unused} / {b.redeemed}
                    </Td>
                    <Td label="Expires">{b.expiresAt ? formatDate(b.expiresAt, tz) : "—"}</Td>
                    <Td label="Status">{b.status === "VOID" ? <Badge tone="neutral">Void</Badge> : b.expired ? <Badge tone="warning">Expired</Badge> : <Badge tone="success">Active</Badge>}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : null}
      {tab === "agents" ? (
        <Card>
          <CardHeader>
            <CardTitle>Agents</CardTitle>
            <CardDescription>Owed = face value of redeemed vouchers − commission − remittances. Direct (no agent) sales owe {formatMoney(agents.direct.owed, cur)}.</CardDescription>
          </CardHeader>
          {agents.agents.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">No agents yet.</CardContent>
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Agent</Th>
                  <Th className="text-right">Commission</Th>
                  <Th className="text-right">Redeemed</Th>
                  <Th className="text-right">Sold</Th>
                  <Th className="text-right">Earned</Th>
                  <Th className="text-right">Remitted</Th>
                  <Th className="text-right">Owes</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {agents.agents.map((a) => (
                  <Tr key={a.id}>
                    <Td label="Agent">
                      <span className="font-medium">{a.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatPhone(a.phone)}
                        {a.status !== "ACTIVE" ? " · inactive" : ""}
                      </span>
                    </Td>
                    <Td label="Commission" className="tabular md:text-right">
                      {a.commissionRate.toString()}%
                    </Td>
                    <Td label="Redeemed" className="tabular md:text-right">
                      {a.redeemed}
                    </Td>
                    <Td label="Sold" className="tabular md:text-right">
                      {formatMoney(a.sold, cur)}
                    </Td>
                    <Td label="Earned" className="tabular md:text-right">
                      {formatMoney(a.commission, cur)}
                    </Td>
                    <Td label="Remitted" className="tabular md:text-right">
                      {formatMoney(a.remitted, cur)}
                    </Td>
                    <Td label="Owes" className="tabular font-medium md:text-right">
                      {formatMoney(a.owed, cur)}
                    </Td>
                    <Td label="Actions" className="md:text-right">
                      <span className="flex justify-end gap-1">
                        {canWrite ? <AgentDialog agent={{ id: a.id, name: a.name, commissionRate: a.commissionRate.toString(), status: a.status }} /> : null}
                        {ctx.permissions.has("payments.record") && Number(a.owed) > 0 ? <RemittanceDialog agentId={a.id} name={a.name} owed={a.owed} currency={cur} /> : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : null}
      {tab === "redeem" && canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Redeem a voucher for a customer</CardTitle>
            <CardDescription>Uses the same single-use rules as the captive portal. The redemption is recorded against your account.</CardDescription>
          </CardHeader>
          <CardContent>
            <StaffRedeemForm />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
