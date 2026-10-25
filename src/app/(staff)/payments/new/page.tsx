import type { Metadata } from "next";
import { z } from "zod";
import { getStaffContextWith } from "@/server/auth/page";
import { db } from "@/server/db/client";
import { tenantWhere } from "@/server/auth/context";
import { PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";
import { PaymentForm } from "./payment-form";

export const metadata: Metadata = { title: "Record payment" };

export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<{ subscriberId?: string; invoiceId?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("payments.record");
  if (!allowed) return <Forbidden what="payment recording" />;
  const sp = await searchParams;
  const subscriber =
    sp.subscriberId && z.uuid().safeParse(sp.subscriberId).success
      ? await db.subscriber.findFirst({ where: { id: sp.subscriberId, ...tenantWhere(ctx) }, select: { id: true, displayName: true, accountNumber: true } })
      : null;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Record payment" description="Cash, bank transfer, cheque or a manually verified M-Pesa receipt. The payment is confirmed on save and a receipt number is issued." />
      <PaymentForm currency={ctx.organization.currency} initialSubscriber={subscriber} focusInvoiceId={sp.invoiceId ?? null} canAllocate={ctx.permissions.has("payments.allocate")} />
    </div>
  );
}
