import { staffRoute } from "@/server/api/handler";
import { campaignInput, createCampaign, listCampaigns } from "@/server/services/campaigns";

/** Bulk message campaigns with delivery counts. */
export const GET = staffRoute({ permission: "notifications.read" }, async ({ ctx }) => ({ data: await listCampaigns(ctx) }));

/** Save a draft campaign (nothing is sent until POST /campaigns/:id/send). */
export const POST = staffRoute({ permission: "notifications.write", body: campaignInput }, async ({ ctx, body }) => ({ data: await createCampaign(ctx, body), status: 201 }));
