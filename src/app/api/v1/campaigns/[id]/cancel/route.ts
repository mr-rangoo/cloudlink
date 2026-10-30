import { staffRoute, uuidParam } from "@/server/api/handler";
import { cancelCampaign } from "@/server/services/campaigns";

/** Cancel a draft or scheduled campaign, or stop one being sent after the current batch. */
export const POST = staffRoute({ permission: "notifications.write", params: uuidParam }, async ({ ctx, params }) => ({ data: await cancelCampaign(ctx, params.id) }));
