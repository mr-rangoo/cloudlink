import type { Metadata } from "next";
import Link from "next/link";
import { LifeBuoy, MessageCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { getStaffContextWith } from "@/server/auth/page";
import { listTickets, ticketListQuery } from "@/server/services/tickets";
import { listAssignableStaff } from "@/server/services/leads";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { PRIORITY_TONE, TICKET_TONE, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { NewTicketDialog } from "./client";

export const metadata: Metadata = { title: "Support" };

export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("support.read");
  if (!allowed) return <Forbidden what="support tickets" />;
  const sp = await searchParams;
  const parsed = ticketListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : ticketListQuery.parse({});
  const canWrite = ctx.permissions.has("support.write");
  const [{ rows, total, statusCounts }, staff] = await Promise.all([listTickets(ctx, query), canWrite ? listAssignableStaff(ctx) : Promise.resolve([])]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const current = { q: sp.q, status: sp.status, assignee: sp.assignee, priority: sp.priority };
  const tz = ctx.organization.timezone;
  const active = (statusCounts.OPEN ?? 0) + (statusCounts.IN_PROGRESS ?? 0) + (statusCounts.WAITING_ON_CUSTOMER ?? 0);
  const href = (patch: Record<string, string | undefined>) => buildHref("/support", current, { ...patch, page: undefined });

  return (
    <div className="space-y-6">
      <PageHeader title="Support tickets" description="Customer tickets from the portal, phone and walk-ins." actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/support/assistant" className={buttonVariants({ variant: "secondary" })}>
              <MessageCircle /> Assistant chats
            </Link>
            {canWrite ? <NewTicketDialog staff={staff} currentUserId={ctx.userId} /> : null}
          </div>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <FilterTabs
            label="Ticket status"
            active={query.status}
            items={[
              { value: "ACTIVE", label: "Active", count: active, href: href({ status: undefined }) },
              { value: "OPEN", label: "Open", count: statusCounts.OPEN ?? 0, href: href({ status: "OPEN" }) },
              { value: "IN_PROGRESS", label: "In progress", count: statusCounts.IN_PROGRESS ?? 0, href: href({ status: "IN_PROGRESS" }) },
              { value: "WAITING_ON_CUSTOMER", label: "Waiting on customer", count: statusCounts.WAITING_ON_CUSTOMER ?? 0, href: href({ status: "WAITING_ON_CUSTOMER" }) },
              { value: "RESOLVED", label: "Resolved", count: statusCounts.RESOLVED ?? 0, href: href({ status: "RESOLVED" }) },
              { value: "CLOSED", label: "Closed", href: href({ status: "CLOSED" }) },
              { value: "ALL", label: "All", href: href({ status: "ALL" }) },
            ]}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <FilterTabs
              label="Assignee"
              active={query.assignee ?? "any"}
              items={[
                { value: "any", label: "Anyone", href: href({ assignee: undefined }) },
                { value: "me", label: "Assigned to me", href: href({ assignee: "me" }) },
                { value: "unassigned", label: "Unassigned", href: href({ assignee: "unassigned" }) },
              ]}
            />
            <SearchForm action="/support" q={sp.q} placeholder="Ticket number or subject" hidden={{ status: sp.status, assignee: sp.assignee }} />
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={LifeBuoy} title="No tickets here" description="Tickets created in the portal or by staff appear in this queue." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Ticket</Th>
                  <Th>Subject</Th>
                  <Th>Subscriber</Th>
                  <Th>Priority</Th>
                  <Th>Status</Th>
                  <Th>Assignee</Th>
                  <Th>Updated</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((t) => (
                  <Tr key={t.id}>
                    <Td label="Ticket" className="font-mono text-xs">
                      <Link href={`/support/${t.id}`} className="text-accent hover:underline">
                        {t.ticketNumber}
                      </Link>
                    </Td>
                    <Td label="Subject">
                      <Link href={`/support/${t.id}`} className="font-medium hover:underline">
                        {t.subject}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {humanize(t.category)} · via {t.channel.replace("_", " ")}
                      </span>
                    </Td>
                    <Td label="Subscriber">{t.subscriber ? t.subscriber.displayName : <span className="text-muted-foreground">—</span>}</Td>
                    <Td label="Priority">
                      <Badge tone={PRIORITY_TONE[t.priority]}>{humanize(t.priority)}</Badge>
                    </Td>
                    <Td label="Status">
                      <Badge tone={TICKET_TONE[t.status]}>{humanize(t.status)}</Badge>
                    </Td>
                    <Td label="Assignee">{t.assigneeName ?? <span className="text-muted-foreground">Unassigned</span>}</Td>
                    <Td label="Updated" className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(t.updatedAt, tz)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={totalPages} total={total} hrefFor={(p) => buildHref("/support", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
