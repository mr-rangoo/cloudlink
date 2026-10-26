import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffContextWith } from "@/server/auth/page";
import { getAssistantConversation } from "@/server/assistant/service";
import { AppError } from "@/server/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Assistant chat" };

const TOOL_LABEL: Record<string, string> = {
  get_account_summary: "Account summary",
  list_invoices: "Invoices",
  list_payments: "Payments",
  get_connection_status: "Connection status",
  get_payment_options: "Payment options",
  create_support_ticket: "Opened a ticket",
};

export default async function AssistantChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("support.read");
  if (!allowed) return <Forbidden what="assistant chats" />;
  const { id } = await params;
  let c: Awaited<ReturnType<typeof getAssistantConversation>>;
  try {
    c = await getAssistantConversation(ctx, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={c.subscriber ? `Chat with ${c.subscriber.displayName}` : "Assistant chat"}
        description={`Started ${formatDateTime(c.createdAt, tz)} · ${c.turns} customer message${c.turns === 1 ? "" : "s"} · ${c.source === "mock" ? "test mode" : (c.model ?? "Claude")}`}
      />
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/support/assistant" className="text-accent hover:underline">
          ← All chats
        </Link>
        {c.subscriber ? (
          <Link href={`/subscribers/${c.subscriber.id}`} className="text-accent hover:underline">
            Subscriber {c.subscriber.accountNumber}
          </Link>
        ) : null}
        {c.ticket ? (
          <Link href={`/support/${c.ticket.id}`} className="text-accent hover:underline">
            Ticket {c.ticket.ticketNumber}
          </Link>
        ) : null}
        {c.status === "OPEN" ? <Badge tone="info">Open</Badge> : <Badge tone="neutral">Ended</Badge>}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {c.messages.map((m) => {
              if (m.toolResults.length && !m.text) {
                const failed = m.toolResults.filter((r) => r.isError).length;
                return failed ? (
                  <li key={m.seq} className="text-xs text-warning">
                    {failed} lookup{failed === 1 ? "" : "s"} returned an error
                  </li>
                ) : null;
              }
              return (
                <li key={m.seq} className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {m.role === "user" ? "Customer" : m.role === "notice" ? "Shown to customer" : "Assistant"} · {formatDateTime(m.createdAt, tz)}
                  </p>
                  {m.text ? <p className={`whitespace-pre-wrap rounded-md px-3 py-2 text-sm ${m.role === "user" ? "bg-accent-soft" : "bg-surface-muted"}`}>{m.text}</p> : null}
                  {m.toolCalls.map((t, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      Looked up: <span className="font-medium text-foreground">{TOOL_LABEL[t.name] ?? t.name}</span>
                      {t.input && Object.keys(t.input as object).length ? <code className="ml-1 break-all">{JSON.stringify(t.input)}</code> : null}
                    </p>
                  ))}
                </li>
              );
            })}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            Tokens used: {c.inputTokens.toLocaleString("en-KE")} in / {c.outputTokens.toLocaleString("en-KE")} out. Lookup results are not shown here; they are the customer&apos;s own records at the time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
