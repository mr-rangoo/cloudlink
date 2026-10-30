import { staffRoute, uuidParam } from "@/server/api/handler";
import { campaignInput, getCampaign, updateCampaign } from "@/server/services/campaigns";

export const GET = staffRoute({ permission: "notifications.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await getCampaign(ctx, params.id) }));

/** Edit a draft. */
export const PATCH = staffRoute({ permission: "notifications.write", params: uuidParam, body: campaignInput }, async ({ ctx, params, body }) => ({ data: await updateCampaign(ctx, params.id, body) }));
