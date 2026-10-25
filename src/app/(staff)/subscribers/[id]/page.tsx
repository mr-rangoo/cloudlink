import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, MapPin, Phone, Router as RouterIcon } from "lucide-react";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getSubscriber, listSubscriberActivity } from "@/server/services/subscribers";
import { listPackages } from "@/server/services/packages";
import { listAccessibleBranches } from "@/server/auth/service";
import { allowedActions } from "@/server/domain/subscription-state";
import { formatPhone } from "@/server/domain/contact";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { RecordStatusBadge, SERVICE_LABEL, SubscriptionStatusBadge, formatInterval, humanize } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";
import { AddSubscriptionDialog, EditSubscriberDialog, NoteForm, SubscriptionActions } from "./client";
import { BillingCard } from "./billing-card";
import { PortalAccessCard } from "./portal-card";
import { portalAccessStatus } from "@/server/portal/auth";

export const metadata: Metadata = { title: "Subscriber" };

export default async function SubscriberDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("subscribers.read");
  if (!allowed) return <Forbidden what="subscribers" />;

  let subscriber;
  try {
    subscriber = await getSubscriber(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const sp = await searchParams;
  const tz = ctx.organization.timezone;
  const canWrite = ctx.permissions.has("subscribers.write");
  const canSubscribe = ctx.permissions.has("subscriptions.write");
  const [activity, packages, branches] = await Promise.all([
    listSubscriberActivity(ctx, id),
    canSubscribe && ctx.permissions.has("packages.read") ? listPackages(ctx, { status: "ACTIVE" }) : Promise.resolve([]),
    canWrite ? listAccessibleBranches(ctx) : Promise.resolve([]),
  ]);
  const live = subscriber.subscriptions.filter((s) => s.status !== "CANCELLED");
  const portal = await portalAccessStatus(ctx, subscriber.id);

  return (
    <div className="space-y-6">
      {sp.created ? <Alert tone="success" title={`Subscriber ${subscriber.accountNumber} created`} /> : null}
      <PageHeader
        title={subscriber.displayName}
        description={`Account ${subscriber.accountNumber} · ${humanize(subscriber.type)}${subscriber.branch ? ` · ${subscriber.branch.name}` : ""}`}
        actions={
          <>
            {canWrite ? (
              <EditSubscriberDialog
                subscriber={{
                  id: subscriber.id,
                  type: subscriber.type,
                  firstName: subscriber.firstName ?? "",
                  lastName: subscriber.lastName ?? "",
                  companyName: subscriber.companyName ?? "",
                  phone: subscriber.phone,
                  altPhone: subscriber.altPhone ?? "",
                  email: subscriber.email ?? "",
                  idNumber: subscriber.idNumber ?? "",
                  notes: subscriber.notes ?? "",
                  status: subscriber.status,
                  branchId: subscriber.branchId,
                }}
                branches={branches}
              />
            ) : null}
            {canSubscribe && subscriber.status !== "ARCHIVED" ? (
              <AddSubscriptionDialog subscriberId={subscriber.id} packages={packages.map((p) => ({ id: p.id, label: `${p.name} — ${p.currency} ${p.price.toFixed(2)} ${formatInterval(p.billingUnit, p.billingCount)}` }))} />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <p className="flex items-center gap-2">
              <Phone className="size-4 text-muted-foreground" aria-hidden /> <span className="sr-only">Phone:</span>
              {formatPhone(subscriber.phone)}
              {subscriber.altPhone ? <span className="text-muted-foreground">· {formatPhone(subscriber.altPhone)}</span> : null}
            </p>
            <p className="flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" aria-hidden /> <span className="sr-only">Email:</span>
              {subscriber.email ?? <span className="text-muted-foreground">No email</span>}
            </p>
            {subscriber.addresses.map((a) => (
              <p key={a.id} className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>{[a.line1, a.area, a.town, a.county].filter(Boolean).join(", ")}</span>
              </p>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <RecordStatusBadge status={subscriber.status} />
              {subscriber.idNumber ? <span className="text-xs text-muted-foreground">ID/PIN: {subscriber.idNumber}</span> : null}
            </div>
            {subscriber.lead ? (
              <p className="text-xs text-muted-foreground">
                Converted from lead{" "}
                <Link href={`/leads/${subscriber.lead.id}`} className="text-accent hover:underline">
                  {subscriber.lead.name}
                </Link>
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:col-span-2 lg:grid-cols-2">
        <PortalAccessCard
          subscriberId={subscriber.id}
          status={portal ? { status: portal.status, lastLoginAt: portal.lastLoginAt?.toISOString() ?? null, activatedAt: portal.activatedAt?.toISOString() ?? null } : null}
          canManage={canWrite}
          messagingMock={(process.env.MESSAGING_ADAPTER ?? "mock") === "mock"}
        />
        <Card>
          <CardHeader>
            <CardTitle>Network access</CardTitle>
            <CardDescription>Billing status and network status are tracked separately.</CardDescription>
          </CardHeader>
          <CardContent className="flex items-start gap-3 text-sm">
            <RouterIcon className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
            <div>
              <Badge tone="neutral">Not provisioned</Badge>
              <p className="mt-1.5 text-muted-foreground">
                Router/RADIUS provisioning is not connected yet (implementation phase 7). Activating a subscription here changes billing status only; no network change is made or claimed.
              </p>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Subscriptions</CardTitle>
          <CardDescription>{live.length ? `${live.length} current` : "No current subscriptions"}</CardDescription>
        </CardHeader>
        {subscriber.subscriptions.length === 0 ? (
          <EmptyState title="No subscriptions" description={canSubscribe ? "Add a subscription to start billing this customer." : undefined} />
        ) : (
          <ul className="divide-y divide-border">
            {subscriber.subscriptions.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{s.packageName}</p>
                    <SubscriptionStatusBadge status={s.status} />
                    <span className="text-xs text-muted-foreground">{SERVICE_LABEL[s.serviceType]}</span>
                  </div>
                  <p className="tabular text-sm text-muted-foreground">
                    {formatMoney(s.price.toString(), s.currency)} {formatInterval(s.billingUnit, s.billingCount)}
                    {Number(s.taxRate) > 0 ? ` + ${s.taxRate.toString()}% tax` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.currentPeriodStart && s.currentPeriodEnd
                      ? `Period ${formatDate(s.currentPeriodStart, tz)} → ${formatDate(s.currentPeriodEnd, tz)}`
                      : "Not yet activated"}
                    {s.graceDays ? ` · ${s.graceDays} grace day(s)` : ""}
                    {s.suspendedAt ? ` · suspended ${formatDateTime(s.suspendedAt, tz)}` : ""}
                    {s.cancelledAt ? ` · cancelled ${formatDate(s.cancelledAt, tz)}` : ""}
                  </p>
                </div>
                {canSubscribe ? <SubscriptionActions subscriptionId={s.id} packageName={s.packageName} actions={allowedActions(s.status)} canInvoice={ctx.permissions.has("invoices.issue")} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {ctx.permissions.has("invoices.read") || ctx.permissions.has("payments.read") ? <BillingCard ctx={ctx} subscriberId={subscriber.id} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Account history, newest first</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canWrite ? <NoteForm subscriberId={subscriber.id} /> : null}
          <ol className="relative space-y-4 border-l border-border pl-5">
            {activity.map((a) => (
              <li key={a.id} className="relative">
                <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-accent" aria-hidden />
                <p className="text-sm">{a.message}</p>
                <p className="text-xs text-muted-foreground">
                  {a.actorName} · {formatDateTime(a.createdAt, tz)}
                </p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
