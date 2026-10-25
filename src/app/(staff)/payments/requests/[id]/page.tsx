import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getAttempt } from "@/server/services/mobile-money";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, PageHeader, type Tone } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { AttemptBadge } from "@/components/mpesa-request";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime, formatMoney } from "@/lib/utils";
import { RequestActions } from "./actions";

export const metadata: Metadata = { title: "M-Pesa request" };

const EVENT_TONE: Record<string, Tone> = { PROCESSED: "success", RECEIVED: "info", REJECTED: "danger", FAILED: "warning" };
const EVENT_LABEL: Record<string, string> = { PROCESSED: "Applied", RECEIVED: "Awaiting verification", REJECTED: "Rejected", FAILED: "Processing error (retrying)" };

export default async function PaymentRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("payments.read");
  if (!allowed) return <Forbidden what="payments" />;
  let a;
  try {
    a = await getAttempt(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={`M-Pesa request · ${formatMoney(a.amount, a.currency)}`}
        description={`${a.channel === "portal" ? "Started by the customer in the portal" : "Sent by staff"} · ${formatDateTime(a.createdAt, tz)}`}
        actions={ctx.permissions.has("payments.initiate") ? <RequestActions id={a.id} status={a.status} canSimulate={a.canSimulate} /> : null}
      />
      {a.simulated ? <Alert tone="warning" title="Simulated request">Made with the mock payment adapter: no prompt was sent and no money moved.</Alert> : null}
      {a.status === "UNKNOWN" ? (
        <Alert tone="warning" title="Outcome unknown">
          {a.detail} Compare with the M-Pesa statement; if the money arrived, it is matched automatically when M-Pesa reports it, or record it under Reconciliation.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {row("Status", <AttemptBadge status={a.status} simulated={a.simulated} />)}
              {row("Explanation", <span className="max-w-xs">{a.detail ?? "—"}</span>)}
              {row("M-Pesa receipt", a.providerReceipt ? <span className="font-mono">{a.providerReceipt}</span> : "—")}
              {row(
                "Payment",
                a.payment ? (
                  <Link href={`/payments/${a.payment.id}`} className="text-accent hover:underline">
                    {a.payment.receiptNumber}
                  </Link>
                ) : (
                  "Not recorded"
                ),
              )}
              {row("Provider checks", `${a.queryCount}${a.lastQueriedAt ? ` · last ${formatDateTime(a.lastQueriedAt, tz)}` : ""}`)}
              {row("Completed", a.completedAt ? formatDateTime(a.completedAt, tz) : "—")}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Request</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {row(
                "Subscriber",
                a.subscriber ? (
                  <Link href={`/subscribers/${a.subscriber.id}`} className="text-accent hover:underline">
                    {a.subscriber.displayName} · {a.subscriber.accountNumber}
                  </Link>
                ) : (
                  "—"
                ),
              )}
              {row(
                "Invoice",
                a.invoice ? (
                  <Link href={`/invoices/${a.invoice.id}`} className="text-accent hover:underline">
                    {a.invoice.invoiceNumber}
                  </Link>
                ) : (
                  "Account balance"
                ),
              )}
              {row("Phone", <span className="font-mono">{a.phone}</span>)}
              {row("Account reference", <span className="font-mono">{a.accountReference}</span>)}
              {row("Sent to M-Pesa", a.submittedAt ? formatDateTime(a.submittedAt, tz) : "Not accepted")}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider callbacks</CardTitle>
          <CardDescription>Stored once each; repeats are counted, never applied twice. Phone numbers are not stored.</CardDescription>
        </CardHeader>
        {a.events.length === 0 ? (
          <CardContent className="text-sm text-muted-foreground">No callback received yet.</CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Received</Th>
                <Th>Result</Th>
                <Th>Handling</Th>
                <Th>Repeats</Th>
                <Th>Note</Th>
              </tr>
            </THead>
            <TBody>
              {a.events.map((e) => {
                const p = e.payload as { resultCode?: string; resultDesc?: string; receipt?: string };
                return (
                  <Tr key={e.id}>
                    <Td label="Received">{formatDateTime(e.receivedAt, tz)}</Td>
                    <Td label="Result">
                      <div className="min-w-0 text-right md:text-left">
                        <span className="font-mono text-xs">{p.resultCode ?? "—"}</span> {p.resultDesc ? <span className="text-xs text-muted-foreground">{p.resultDesc}</span> : null}
                      </div>
                    </Td>
                    <Td label="Handling">
                      <Badge tone={EVENT_TONE[e.status] ?? "neutral"}>{EVENT_LABEL[e.status] ?? e.status}</Badge>
                    </Td>
                    <Td label="Repeats">
                      {e.duplicateCount}
                      {e.conflictingDuplicate ? " (one differed)" : ""}
                    </Td>
                    <Td label="Note" className="text-xs">
                      {e.error ?? (p.receipt ? `Receipt ${p.receipt}` : "—")}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
