import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { confirmTestReceived } from "@/server/services/messaging-config";

/** Staff confirm the last accepted test message arrived; only this marks the provider as verified. */
export const POST = staffRoute({ permission: "integrations.write", body: z.object({ channel: z.enum(["SMS", "EMAIL"]) }) }, async ({ ctx, body }) => ({ data: await confirmTestReceived(ctx, body.channel) }));
