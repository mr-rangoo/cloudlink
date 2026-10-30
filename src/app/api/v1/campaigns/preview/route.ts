import { staffRoute } from "@/server/api/handler";
import { campaignInput, previewCampaign } from "@/server/services/campaigns";

/** Audience size, how many would actually receive it (preferences and consent), and a sample message. */
export const POST = staffRoute({ permission: "notifications.write", body: campaignInput }, async ({ ctx, body }) => ({ data: await previewCampaign(ctx, body) }));
