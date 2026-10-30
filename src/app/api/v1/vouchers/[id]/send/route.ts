import { staffRoute, uuidParam } from "@/server/api/handler";
import { sendVoucherBySms, sendVoucherInput } from "@/server/services/vouchers";

/** Text an unused voucher's code to a phone (needs vouchers.export; audited; the code is not stored in the message). */
export const POST = staffRoute({ permission: "vouchers.export", params: uuidParam, body: sendVoucherInput }, async ({ ctx, params, body }) => ({ data: await sendVoucherBySms(ctx, params.id, body), status: 202 }));
