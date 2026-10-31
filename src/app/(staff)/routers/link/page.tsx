import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { listAccessibleBranches } from "@/server/auth/service";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { IdentityForm, LinkStepper } from "../link-wizard";

export const metadata: Metadata = { title: "Link a MikroTik" };

/** Link a MikroTik, step 1 (Identity). Steps 2–4 continue at /routers/:id/setup. */
export default async function LinkRouterPage() {
  const { ctx, allowed } = await getStaffContextWith("routers.write");
  if (!allowed) return <Forbidden what="router setup" />;
  const branches = await listAccessibleBranches(ctx);
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Devices — Routers — Link" title="Link a MikroTik" description="Four steps: name it, run one command on it, choose its services and ports, done." />
      <LinkStepper active="identity" />
      <IdentityForm branches={branches.map((b) => ({ id: b.id, name: b.name }))} />
    </div>
  );
}
