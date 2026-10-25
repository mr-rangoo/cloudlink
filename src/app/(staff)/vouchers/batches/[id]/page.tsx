import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getBatch } from "@/server/services/vouchers";
import { describeInterval } from "@/server/domain/billing-period";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { ActionDialog } from "@/components/action-dialog";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Voucher batch" };

const TONE: Record<string, Tone> = { UNUSED: "info", REDEEMED: "success", EXPIRED: "warning", VOID: "neutral" };
const ACT: Record<string, Tone> = { SIMULATED: "warning", ACTIVE: "success", FAILED: "danger", PENDING: "info" };

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("vouchers.read");
  if (!allowed) return <Forbidden what="vouchers" />;
  let b;
  try {
    b = await getBatch(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  const unused = b.vouchers.filter((v) => v.status === "UNUSED").length;
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Batch ${b.batchNumber}`}
        description={`${b.packageName} · ${describeInterval(b.durationUnit, b.durationCount)} · ${formatMoney(b.faceValue.toString(), b.currency)} each · ${b.agent ? `agent ${b.agent.name}` : "direct sales"}`}
        actions={
          <>
            {ctx.permissions.has("vouchers.export") && b.status === "ACTIVE" && unused ? (
              <>
                <a href={`/api/v1/vouchers/batches/${b.id}/export`} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium shadow-sm hover:bg-surface-muted">
                  <Download className="size-4" /> Cards (PDF)
                </a>
                <a href={`/api/v1/vouchers/batches/${b.id}/export?format=csv`} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium shadow-sm hover:bg-surface-muted">
                  <Download className="size-4" /> CSV
                </a>
              </>
            ) : null}
            {ctx.permissions.has("vouchers.write") && b.status === "ACTIVE" ? (
              <ActionDialog label="Void unused" title="Void batch" tone="danger" triggerSize="md" path={`/vouchers/batches/${b.id}/void`} reason="required" success="Batch voided" impact={`${unused} unused voucher(s) will stop working. Redeemed vouchers are not affected.`} />
            ) : null}
          </>
        }
      />
      {b.exportCount ? <Alert tone="info">Codes from this batch have been exported {b.exportCount} time(s). Each export is in the audit log.</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>
            Vouchers <span className="text-sm font-normal text-muted-foreground">· expires {b.expiresAt ? formatDate(b.expiresAt, tz) : "never"}</span>
          </CardTitle>
        </CardHeader>
        <Table>
          <THead>
            <tr>
              <Th>Code ends</Th>
              <Th>Status</Th>
              <Th>Redeemed</Th>
              <Th>Channel</Th>
              <Th>Network activation</Th>
              <Th>Access until</Th>
            </tr>
          </THead>
          <TBody>
            {b.vouchers.map((v) => (
              <Tr key={v.id}>
                <Td label="Code ends" className="font-mono text-xs">
                  …{v.codeHint}
                </Td>
                <Td label="Status">
                  <Badge tone={TONE[v.status] ?? "neutral"}>{humanize(v.status)}</Badge>
                </Td>
                <Td label="Redeemed">{v.redeemedAt ? formatDateTime(v.redeemedAt, tz) : "—"}</Td>
                <Td label="Channel">{v.redemption ? humanize(v.redemption.channel) : "—"}</Td>
                <Td label="Network activation">{v.redemption ? <Badge tone={ACT[v.redemption.activationStatus] ?? "neutral"}>{humanize(v.redemption.activationStatus)}</Badge> : "—"}</Td>
                <Td label="Access until">{v.redemption ? formatDateTime(v.redemption.accessEndsAt, tz) : "—"}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <CardContent className="text-xs text-muted-foreground">Full codes are never shown here; they are stored encrypted and revealed only through audited exports.</CardContent>
      </Card>
    </div>
  );
}
