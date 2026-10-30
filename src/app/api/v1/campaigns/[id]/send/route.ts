import { staffRoute, uuidParam } from "@/server/api/handler";
import { sendCampaign, sendCampaignInput } from "@/server/services/campaigns";

/** Send a draft now, or at `scheduledAt`. A campaign is sent once; the audience is resolved when sending starts. */
export const POST = staffRoute({ permission: "notifications.write", params: uuidParam, body: sendCampaignInput }, async ({ ctx, params, body }) => ({ data: await sendCampaign(ctx, params.id, body), status: 202 }));
