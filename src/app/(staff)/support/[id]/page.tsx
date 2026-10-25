import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, Lock } from "lucide-react";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getTicket } from "@/server/services/tickets";
import { listAssignableStaff } from "@/server/services/leads";
import { isAppError } from "@/server/errors";
import { formatPhone } from "@/server/domain/contact";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader } from "@/components/ui/feedback";
import { PRIORITY_TONE, TICKET_TONE, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { AttachmentUpload } from "../client";
import { ReplyForm, TicketUpdateForm } from "./client";

export const metadata: Metadata = { title: "Ticket" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("support.read");
  if (!allowed) return <Forbidden what="support tickets" />;
  let t;
  try {
    t = await getTicket(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const canWrite = ctx.permissions.has("support.write");
  const staff = canWrite ? await listAssignableStaff(ctx) : [];
  const tz = ctx.organization.timezone;
  const timeline = [
    ...t.comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, c })),
    ...t.events.filter((e) => e.type !== "created").map((e) => ({ kind: "event" as const, at: e.createdAt, e })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <div className="space-y-6">
      <PageHeader title={t.subject} description={`${t.ticketNumber} · ${humanize(t.category)} · opened ${formatDateTime(t.createdAt, tz)} via ${t.channel.replace("_", " ")}`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="space-y-1 pt-4">
              <p className="text-xs font-medium text-muted-foreground">Original request</p>
              <p className="whitespace-pre-wrap text-sm">{t.description}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Conversation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {timeline.length === 0 ? <p className="text-sm text-muted-foreground">No replies yet.</p> : null}
              <ol className="space-y-3">
                {timeline.map((item) =>
                  item.kind === "comment" ? (
                    <li key={item.c.id} className={`rounded-lg border p-3 text-sm ${item.c.internal ? "border-warning/30 bg-warning-soft/60" : item.c.fromCustomer ? "border-border bg-surface-muted/60" : "border-accent/20 bg-accent-soft/40"}`}>
                      <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{item.c.authorName}</span>
                        {item.c.fromCustomer ? <Badge tone="neutral">Customer</Badge> : null}
                        {item.c.internal ? (
                          <Badge tone="warning">
                            <Lock className="size-3" aria-hidden /> Internal note
                          </Badge>
                        ) : null}
                        <span>{formatDateTime(item.c.createdAt, tz)}</span>
                      </p>
                      <p className="whitespace-pre-wrap">{item.c.body}</p>
                    </li>
                  ) : (
                    <li key={item.e.id} className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-border-strong" aria-hidden />
                      {item.e.actorName} {item.e.type === "assigned" ? "changed the assignee" : `${item.e.type.replace("_", " ")}`}
                      {item.e.toValue && item.e.type !== "assigned" ? ` → ${humanize(item.e.toValue)}` : ""} · {formatDateTime(item.e.createdAt, tz)}
                    </li>
                  ),
                )}
              </ol>
              {canWrite && t.status !== "CLOSED" ? <ReplyForm ticketId={t.id} hasSubscriber={Boolean(t.subscriber)} /> : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Status</CardTitle>
              <Badge tone={TICKET_TONE[t.status]}>{humanize(t.status)}</Badge>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Priority">
                <Badge tone={PRIORITY_TONE[t.priority]}>{humanize(t.priority)}</Badge>
              </Row>
              <Row label="Assignee">{t.assigneeName ?? "Unassigned"}</Row>
              <Row label="First response">{t.firstResponseAt ? formatDateTime(t.firstResponseAt, tz) : "Not yet"}</Row>
              {t.resolution ? <p className="rounded-md bg-success-soft p-2 text-xs">Resolution: {t.resolution}</p> : null}
              {canWrite ? <TicketUpdateForm ticketId={t.id} status={t.status} priority={t.priority} assigneeId={t.assigneeId} staff={staff} /> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Subscriber</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {t.subscriber ? (
                <div className="space-y-1">
                  <Link href={`/subscribers/${t.subscriber.id}`} className="font-medium text-accent hover:underline">
                    {t.subscriber.displayName}
                  </Link>
                  <p className="text-muted-foreground">
                    {t.subscriber.accountNumber} · {formatPhone(t.subscriber.phone)}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">Not linked to a subscriber.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {t.attachments.length === 0 ? <p className="text-muted-foreground">None.</p> : null}
              <ul className="space-y-1">
                {t.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={`/api/v1/support/attachments/${a.id}`} className="inline-flex items-center gap-1.5 text-accent hover:underline">
                      <FileText className="size-3.5" aria-hidden /> {a.fileName}
                    </a>{" "}
                    <span className="text-xs text-muted-foreground">{Math.ceil(a.sizeBytes / 1024)} KB{a.uploadedByCustomerId ? " · from customer" : ""}</span>
                  </li>
                ))}
              </ul>
              {canWrite && t.status !== "CLOSED" ? <AttachmentUpload path={`/support/tickets/${t.id}/attachments`} /> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
