import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getNetworkOperation } from "@/server/services/network";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { OperationStatusBadge, VERIFICATION_LABEL } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { OperationActions } from "../../client";

export const metadata: Metadata = { title: "Network operation" };

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  SUCCESS: { label: "Succeeded", tone: "success" },
  SIMULATED: { label: "Simulated", tone: "neutral" },
  RETRYABLE_ERROR: { label: "Failed, will retry", tone: "warning" },
  PERMANENT_ERROR: { label: "Failed permanently", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export default async function OperationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("network.read");
  if (!allowed) return <Forbidden what="network operations" />;
  let op;
  try {
    op = await getNetworkOperation(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  const params2 = op.params as Record<string, unknown>;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={op.label}
        description={`Requested ${formatDateTime(op.createdAt, tz)} by ${op.requestedBy === "user" ? "staff" : op.requestedBy}`}
        actions={ctx.permissions.has("network.operate") ? <OperationActions id={op.id} status={op.status} label={op.label} /> : null}
      />
      {op.status === "SIMULATED" ? <Alert tone="info">This result came from the mock adapter. No router or RADIUS server was changed.</Alert> : null}
      {op.status === "RETRYING" ? <Alert tone="warning">The last attempt failed with a temporary error. The worker retries automatically with increasing delays.</Alert> : null}
      {op.status === "FAILED" ? <Alert tone="danger" title="Operation failed">{op.resultDetail}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {row("Status", <OperationStatusBadge status={op.status} />)}
              {row("Verification", VERIFICATION_LABEL[op.verification] ?? op.verification)}
              {row("Attempts", `${op.attempts} of ${op.maxAttempts}`)}
              {row("Started", op.startedAt ? formatDateTime(op.startedAt, tz) : "—")}
              {row("Completed", op.completedAt ? formatDateTime(op.completedAt, tz) : "—")}
              {op.resultDetail ? row("Detail", <span className="max-w-xs break-words">{op.resultDetail}</span>) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Target</CardTitle>
            <CardDescription>Only allowlisted operation types exist; passwords are never stored in operation records.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {row(
                "Router",
                op.router ? (
                  <Link href={`/routers/${op.router.id}`} className="text-accent hover:underline">
                    {op.router.name}
                  </Link>
                ) : (
                  "None registered"
                ),
              )}
              {row(
                "Subscriber",
                op.subscriber ? (
                  <Link href={`/subscribers/${op.subscriber.id}`} className="text-accent hover:underline">
                    {op.subscriber.displayName} · {op.subscriber.accountNumber}
                  </Link>
                ) : (
                  "—"
                ),
              )}
              {params2.username ? row("Username", <span className="font-mono">{String(params2.username)}</span>) : null}
              {params2.kind ? row("Session type", String(params2.kind) === "PPPOE" ? "PPPoE" : "Hotspot") : null}
              {params2.reason ? row("Reason", String(params2.reason)) : null}
              {op.redemptionId ? row("Voucher redemption", <span className="font-mono text-xs">{op.redemptionId}</span>) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Attempt log</CardTitle>
          <CardDescription>Every attempt is recorded and cannot be edited.</CardDescription>
        </CardHeader>
        {op.attemptsLog.length === 0 ? (
          <CardContent className="text-sm text-muted-foreground">Not attempted yet. The worker picks up queued operations within seconds.</CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>#</Th>
                <Th>Outcome</Th>
                <Th>Error code</Th>
                <Th>Detail</Th>
                <Th className="text-right">Duration</Th>
                <Th>When</Th>
              </tr>
            </THead>
            <TBody>
              {op.attemptsLog.map((a) => {
                const o = OUTCOME[a.outcome] ?? { label: a.outcome, tone: "neutral" as Tone };
                return (
                  <Tr key={a.id}>
                    <Td label="#" className="tabular">
                      {a.attemptNumber}
                    </Td>
                    <Td label="Outcome">
                      <Badge tone={o.tone}>{o.label}</Badge>
                    </Td>
                    <Td label="Error code" className="font-mono text-xs">
                      {a.errorCode ?? "—"}
                    </Td>
                    <Td label="Detail" className="max-w-md break-words text-xs">
                      {a.detail ?? "—"}
                    </Td>
                    <Td label="Duration" className="tabular md:text-right">
                      {a.durationMs} ms
                    </Td>
                    <Td label="When">{formatDateTime(a.createdAt, tz)}</Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {op.alerts.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border">
            {op.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
                <Badge tone={a.status === "RESOLVED" ? "neutral" : "danger"}>{a.status === "RESOLVED" ? "Resolved" : "Open"}</Badge>
                {a.message}
                <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt, tz)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
