import { staffRoute } from "@/server/api/handler";
import { redeemInput, redeemVoucher } from "@/server/services/vouchers";

/** Staff-assisted redemption (e.g. support helping a customer). Same atomic rules as the captive portal. */
export const POST = staffRoute({ permission: "vouchers.write", body: redeemInput }, async ({ ctx, body }) => ({ data: await redeemVoucher(ctx, body, "staff"), status: 201 }));
