import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { getPackage, planRouterChoices } from "@/server/services/packages";
import { listNetworkOperations } from "@/server/services/network";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/feedback";
import { OperationStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { PlanForm } from "../plan-form";

export const metadata: Metadata = { title: "Plan" };

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { ctx, allowed } = await getStaffContextWith("packages.read");
  if (!allowed) return <Forbidden what="plans" />;
  let plan;
  try {
    plan = await getPackage(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const canWrite = ctx.permissions.has("packages.write") && plan.availability !== "ARCHIVED";
  const canSync = ctx.permissions.has("network.operate");
  const [routers, recent] = await Promise.all([
    planRouterChoices(ctx),
    ctx.permissions.has("network.read") ? listNetworkOperations(ctx, { packageId: plan.id, status: "ALL", page: 1, pageSize: 8 }) : null,
  ]);
  const pushes = recent?.rows ?? [];
  const tz = ctx.organization.timezone;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={plan.name} description="Changes apply to new sales. Existing subscriptions keep the price and terms they were sold with." />
      {plan.availability === "ARCHIVED" ? <Alert tone="warning" title="Archived">This plan is no longer sold. Restore it from the plans list to edit it.</Alert> : null}
      <PlanForm
        initial={{
          id: plan.id,
          name: plan.name,
          description: plan.description,
          planType: plan.planType,
          availability: plan.availability,
          highlight: plan.highlight,
          price: plan.price.toFixed(2),
          taxRate: plan.taxRate.toString(),
          billingUnit: plan.billingUnit,
          billingCount: plan.billingCount,
          uploadKbps: plan.uploadKbps,
          downloadKbps: plan.downloadKbps,
          deviceLimit: plan.deviceLimit,
          dataQuotaMb: plan.dataQuotaMb,
          burstUploadKbps: plan.burstUploadKbps,
          burstDownloadKbps: plan.burstDownloadKbps,
          burstThresholdUploadKbps: plan.burstThresholdUploadKbps,
          burstThresholdDownloadKbps: plan.burstThresholdDownloadKbps,
          burstTimeSeconds: plan.burstTimeSeconds,
          fupEnabled: plan.fupEnabled,
          fupThresholdMb: plan.fupThresholdMb,
          fupAction: plan.fupAction,
          fupUploadKbps: plan.fupUploadKbps,
          fupDownloadKbps: plan.fupDownloadKbps,
          scheduleEnabled: plan.scheduleEnabled,
          scheduleStartMinute: plan.scheduleStartMinute,
          scheduleEndMinute: plan.scheduleEndMinute,
          scheduleDays: plan.scheduleDays,
          trialCooldownDays: plan.trialCooldownDays,
          routerIds: plan.routerIds,
          networkProfile: plan.networkProfile,
          sortOrder: plan.sortOrder,
        }}
        routers={routers}
        currency={plan.currency}
        readOnly={!canWrite}
        canSync={canSync}
      />
      {recent ? (
        <Card>
          <CardHeader>
            <CardTitle>Router profile pushes</CardTitle>
            <CardDescription>
              Profile <span className="font-mono">{plan.networkProfile ?? plan.name}</span> on each router that uses this plan.{" "}
              <Link href="/sessions?tab=operations" className="text-accent hover:underline">
                All operations
              </Link>
            </CardDescription>
          </CardHeader>
          {pushes.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">Nothing pushed yet. Plans with a rate limit are pushed when saved.</CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {pushes.map((o) => (
                <li key={o.id} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <Link href={`/sessions/operations/${o.id}`} className="font-medium text-accent hover:underline">
                      {o.routerName ?? "Router"}
                    </Link>
                    {o.resultDetail ? <span className="block truncate text-xs text-muted-foreground">{o.resultDetail}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    {formatDateTime(o.createdAt, tz)}
                    <OperationStatusBadge status={o.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  );
}
