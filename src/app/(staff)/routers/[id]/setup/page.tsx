import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffContextWith } from "@/server/auth/page";
import { getRouterLink } from "@/server/services/router-link";
import { isAppError } from "@/server/errors";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { SetupWizard, type LinkView, type StepKey } from "../../link-wizard";

export const metadata: Metadata = { title: "Router setup" };

/** Link a MikroTik, steps 2–4: provision (setup command), services (hotspot / PPPoE / ports), done. */
export default async function RouterSetupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("routers.read");
  if (!allowed) return <Forbidden what="routers" />;
  const { id } = await params;
  const sp = await searchParams;
  let state;
  try {
    state = await getRouterLink(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const view = JSON.parse(JSON.stringify(state)) as LinkView;
  const fallback: StepKey = !state.linkedAt ? "provision" : state.change?.status === "APPLIED" ? "done" : "services";
  const step: StepKey = sp.step === "provision" || sp.step === "services" || sp.step === "done" ? sp.step : fallback;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Devices — Routers — Setup"
        title="Link a MikroTik"
        description={
          <>
            <Link href="/routers" className="hover:underline">
              Routers
            </Link>{" "}
            /{" "}
            <Link href={`/routers/${state.id}`} className="hover:underline">
              {state.name}
            </Link>{" "}
            / Setup
          </>
        }
      />
      <SetupWizard initial={view} initialStep={step} canWrite={ctx.permissions.has("routers.write")} />
    </div>
  );
}
