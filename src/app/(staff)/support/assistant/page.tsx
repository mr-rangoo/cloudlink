import type { Metadata } from "next";
import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { conversationListQuery, listAssistantConversations } from "@/server/assistant/service";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { SearchForm } from "@/components/list-toolbar";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Assistant chats" };

export default async function AssistantChatsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("support.read");
  if (!allowed) return <Forbidden what="assistant chats" />;
  const sp = await searchParams;
  const parsed = conversationListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : conversationListQuery.parse({});
  const { rows, total } = await listAssistantConversations(ctx, query);
  const tz = ctx.organization.timezone;
  return (
    <div className="space-y-6">
      <PageHeader title="Assistant chats" description="Customer conversations with the portal AI assistant, including which account lookups it made. Kept for 180 days." />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/support" className="text-sm text-accent hover:underline">
            ← Support tickets
          </Link>
          <SearchForm action="/support/assistant" q={sp.q} placeholder="Customer name or account" />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={MessageCircle} title="No chats yet" description="Chats appear here once customers use the assistant. Turn it on under Settings → AI assistant." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Messages</Th>
                  <Th>Ticket</Th>
                  <Th>Last message</Th>
                  <Th>Status</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((c) => (
                  <Tr key={c.id}>
                    <Td label="Customer">
                      <Link href={`/support/assistant/${c.id}`} className="font-medium text-accent hover:underline">
                        {c.subscriber ? `${c.subscriber.displayName} · ${c.subscriber.accountNumber}` : "Unknown customer"}
                      </Link>
                    </Td>
                    <Td label="Messages" className="tabular">
                      {c.turns}
                    </Td>
                    <Td label="Ticket">
                      {c.ticket ? (
                        <Link href={`/support/${c.ticket.id}`} className="font-mono text-xs hover:underline">
                          {c.ticket.ticketNumber}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td label="Last message">{formatDateTime(c.lastMessageAt, tz)}</Td>
                    <Td label="Status">
                      <span className="flex flex-wrap gap-1">
                        {c.status === "OPEN" ? <Badge tone="info">Open</Badge> : <Badge tone="neutral">Ended</Badge>}
                        {c.source === "mock" ? <Badge tone="warning">Test mode</Badge> : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/support/assistant", { q: sp.q }, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
