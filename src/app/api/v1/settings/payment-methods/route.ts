import { staffRoute } from "@/server/api/handler";
import { createPaymentMethod, listPaymentMethods, paymentMethodInput } from "@/server/services/payment-methods";

/** Ways customers can pay (shown in the portal and on invoices). */
export const GET = staffRoute({ permission: "settings.write" }, async ({ ctx }) => ({ data: await listPaymentMethods(ctx) }));
export const POST = staffRoute({ permission: "settings.write", body: paymentMethodInput }, async ({ ctx, body }) => ({ data: await createPaymentMethod(ctx, body), status: 201 }));
