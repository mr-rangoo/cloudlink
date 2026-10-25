import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { listPackages } from "@/server/services/packages";
import { listAccessibleBranches } from "@/server/auth/service";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { SubscriberForm } from "./subscriber-form";

export const metadata: Metadata = { title: "New subscriber" };

export default async function NewSubscriberPage() {
  const { ctx, allowed } = await getStaffContextWith("subscribers.write");
  if (!allowed) return <Forbidden what="subscriber creation" />;
  const canSubscribe = ctx.permissions.has("subscriptions.write");
  const [packages, branches] = await Promise.all([
    canSubscribe && ctx.permissions.has("packages.read") ? listPackages(ctx, { status: "ACTIVE" }) : Promise.resolve([]),
    listAccessibleBranches(ctx),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="New subscriber" description="Create the customer account and, optionally, their first subscription." />
      <SubscriberForm
        packages={packages.map((p) => ({ id: p.id, label: `${p.name} — ${p.currency} ${p.price.toFixed(2)}` }))}
        branches={branches}
        defaultBranchId={ctx.activeBranchId ?? (branches.length === 1 ? branches[0]!.id : null)}
        branchRequired={ctx.branchIds !== null}
        canSubscribe={canSubscribe}
      />
    </div>
  );
}
