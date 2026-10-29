import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { planRouterChoices } from "@/server/services/packages";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { PlanForm } from "../plan-form";

export const metadata: Metadata = { title: "New plan" };

export default async function NewPlanPage() {
  const { ctx, allowed } = await getStaffContextWith("packages.write");
  if (!allowed) return <Forbidden what="plans" />;
  const routers = await planRouterChoices(ctx);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader eyebrow="Plans · New" title="Create a plan" description="Price, duration, speed limits, scheduling and router restrictions. Existing subscriptions are never changed by plan edits." />
      <PlanForm routers={routers} currency={ctx.organization.currency} canSync={ctx.permissions.has("network.operate")} />
    </div>
  );
}
