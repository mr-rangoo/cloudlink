import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { z } from "zod";
import { getCustomerContext } from "@/server/portal/page";
import { getCustomerTicket } from "@/server/services/tickets";
import { isAppError } from "@/server/errors";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { TICKET_TONE, humanize } from "@/components/status";
import { AttachmentUpload } from "@/app/(staff)/support/client";
import { formatDateTime } from "@/lib/utils";
import { CustomerReply } from "./reply";

export const metadata: Metadata = { title: "Support request · Customer portal" };

export default async function PortalTicket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await getCustomerContext();
  let t;
  try {
    t = await getCustomerTicket(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const tz = ctx.organization.timezone;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t.subject}</h1>
          <p className="text-sm text-muted-foreground">
            {t.ticketNumber} · opened {formatDateTime(t.createdAt, tz)}
          </p>
        </div>
        <Badge tone={TICKET_TONE[t.status]}>{humanize(t.status)}</Badge>
      </div>
      {t.resolution && t.status === "RESOLVED" ? (
        <p className="rounded-md border border-success/20 bg-success-soft p-3 text-sm">
          <span className="font-medium">Resolved:</span> {t.resolution}
        </p>
      ) : null}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="rounded-lg border border-border bg-surface-muted/60 p-3 text-sm">
            <p className="mb-1 text-xs text-muted-foreground">You · {formatDateTime(t.createdAt, tz)}</p>
            <p className="whitespace-pre-wrap">{t.description}</p>
          </div>
          {t.comments.map((c) => (
            <div key={c.id} className={`rounded-lg border p-3 text-sm ${c.fromCustomer ? "border-border bg-surface-muted/60" : "border-accent/20 bg-accent-soft/40"}`}>
              <p className="mb-1 text-xs text-muted-foreground">
                {c.fromCustomer ? "You" : `${ctx.organization.name} support`} · {formatDateTime(c.createdAt, tz)}
              </p>
              <p className="whitespace-pre-wrap">{c.body}</p>
            </div>
          ))}
          {t.attachments.length ? (
            <ul className="space-y-1 text-sm">
              {t.attachments.map((a) => (
                <li key={a.id}>
                  <a href={`/api/v1/customer/attachments/${a.id}`} className="inline-flex items-center gap-1.5 text-accent hover:underline">
                    <FileText className="size-3.5" aria-hidden /> {a.fileName}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {t.status !== "CLOSED" ? (
            <>
              <CustomerReply ticketId={t.id} reopens={t.status === "RESOLVED"} />
              <AttachmentUpload path={`/customer/tickets/${t.id}/attachments`} label="Attach photo or document" />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">This request is closed. Open a new request if you need more help.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
