import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getLead, listAssignableStaff } from "@/server/services/leads";
import { listPackages } from "@/server/services/packages";
import { findContactDuplicates } from "@/server/services/subscribers";
import { formatPhone } from "@/server/domain/contact";
import { db } from "@/server/db/client";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/feedback";
import { LeadStageBadge, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { ConvertLeadDialog, LeadActivityForm, LeadStageForm } from "./client";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("leads.read");
  if (!allowed) return <Forbidden what="leads" />;
  let lead;
  try {
    lead = await getLead(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const canWrite = ctx.permissions.has("leads.write");
  const canConvert = canWrite && ctx.permissions.has("subscribers.write");
  const editable = canWrite && lead.stage !== "WON";
  const [staff, packages, matches] = await Promise.all([
    editable ? listAssignableStaff(ctx) : Promise.resolve([]),
    editable && ctx.permissions.has("packages.read") ? listPackages(ctx, { status: "ACTIVE" }) : Promise.resolve([]),
    lead.stage !== "WON" ? findContactDuplicates(db, ctx.organizationId, lead.phone, lead.email) : Promise.resolve([]),
  ]);
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.name}
        description={`${humanize(lead.source)} lead · created ${formatDateTime(lead.createdAt, tz)}`}
        actions={
          editable && canConvert && lead.stage !== "LOST" ? (
            <ConvertLeadDialog
              leadId={lead.id}
              name={lead.name}
              packages={packages.map((p) => ({ id: p.id, name: p.name }))}
              defaultPackageId={lead.interestedPackageId}
              hasDuplicate={matches.length > 0}
              canSubscribe={ctx.permissions.has("subscriptions.write")}
            />
          ) : null
        }
      />
      {lead.convertedSubscriber ? (
        <Alert tone="success" title="Converted">
          This lead became subscriber{" "}
          <Link href={`/subscribers/${lead.convertedSubscriber.id}`} className="font-medium text-accent hover:underline">
            {lead.convertedSubscriber.accountNumber} {lead.convertedSubscriber.displayName}
          </Link>
          . The lead record is kept read-only for history.
        </Alert>
      ) : null}
      {matches.length ? (
        <Alert tone="warning" title="Matches an existing subscriber">
          Same phone or email as{" "}
          {matches.map((m, i) => (
            <span key={m.id}>
              {i ? ", " : ""}
              <Link href={`/subscribers/${m.id}`} className="font-medium text-accent hover:underline">
                {m.accountNumber} {m.displayName}
              </Link>
            </span>
          ))}
          . Conversion will require confirming this is a different customer.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Detail label="Stage">
                <LeadStageBadge stage={lead.stage} />
              </Detail>
              <Detail label="Phone">{formatPhone(lead.phone)}</Detail>
              <Detail label="Email">{lead.email ?? "—"}</Detail>
              <Detail label="Location">{lead.location ?? "—"}</Detail>
              <Detail label="Interested in">{lead.interestedPackage?.name ?? "—"}</Detail>
              <Detail label="Owner">{lead.ownerName ?? "Unassigned"}</Detail>
              {lead.lostReason ? <Detail label="Lost reason">{lead.lostReason}</Detail> : null}
              {lead.notes ? <p className="whitespace-pre-wrap rounded-md bg-surface-muted p-3 text-sm">{lead.notes}</p> : null}
            </CardContent>
          </Card>
          {editable ? (
            <Card>
              <CardHeader>
                <CardTitle>Update</CardTitle>
              </CardHeader>
              <CardContent>
                <LeadStageForm leadId={lead.id} stage={lead.stage} ownerId={lead.ownerId} staff={staff} interestedPackageId={lead.interestedPackageId} packages={packages.map((p) => ({ id: p.id, name: p.name }))} />
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
            <CardDescription>All interactions and changes, newest first</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {editable ? <LeadActivityForm leadId={lead.id} /> : null}
            <ol className="relative space-y-4 border-l border-border pl-5">
              {lead.activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-accent" aria-hidden />
                  <p className="text-sm">
                    <span className="mr-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{humanize(a.type)}</span>
                    {a.message}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {a.actorName} · {formatDateTime(a.createdAt, tz)}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
