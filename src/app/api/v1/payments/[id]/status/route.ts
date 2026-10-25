import { staffRoute, uuidParam } from "@/server/api/handler";
import { getPayment } from "@/server/services/payments";

/** Server-side payment status (clients poll this; a browser redirect is never proof of payment). */
export const GET = staffRoute({ permission: "payments.read", params: uuidParam }, async ({ ctx, params }) => {
  const p = await getPayment(ctx, params.id);
  return { data: { id: p.id, status: p.status, receiptNumber: p.receiptNumber, amount: p.amount, currency: p.currency, unallocated: p.unallocated } };
});
