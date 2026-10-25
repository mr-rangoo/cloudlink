import type { Metadata } from "next";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { db } from "@/server/db/client";
import { tenantWhere } from "@/server/auth/context";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { InvoiceForm } from "./invoice-form";

export const metadata: Metadata = { title: "New invoice" };

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ subscriberId?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("invoices.write");
  if (!allowed) return <Forbidden what="invoice creation" />;
  const sp = await searchParams;
  const pre = sp.subscriberId && z.uuid().safeParse(sp.subscriberId).success
    ? await db.subscriber.findFirst({ where: { id: sp.subscriberId, ...tenantWhere(ctx) }, select: { id: true, displayName: true, accountNumber: true } })
    : null;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="New invoice" description="Manual invoice for equipment, installation or other charges. Subscription periods are invoiced automatically." />
      <InvoiceForm currency={ctx.organization.currency} canIssue={ctx.permissions.has("invoices.issue")} initialSubscriber={pre} />
    </div>
  );
}
