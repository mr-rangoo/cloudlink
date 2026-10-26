import { staffRoute, uuidParam } from "@/server/api/handler";
import { deletePaymentMethod, paymentMethodInput, paymentMethodUpdate, replacePaymentMethod, updatePaymentMethod } from "@/server/services/payment-methods";

/** Replace a payment method's details. */
export const PUT = staffRoute({ permission: "settings.write", params: uuidParam, body: paymentMethodInput }, async ({ ctx, params, body }) => ({ data: await replacePaymentMethod(ctx, params.id, body) }));
/** Show/hide or reorder. */
export const PATCH = staffRoute({ permission: "settings.write", params: uuidParam, body: paymentMethodUpdate }, async ({ ctx, params, body }) => ({ data: await updatePaymentMethod(ctx, params.id, body) }));
export const DELETE = staffRoute({ permission: "settings.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await deletePaymentMethod(ctx, params.id) }));
