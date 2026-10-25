import { staffRoute, uuidParam } from "@/server/api/handler";
import { commitSubscriberImport } from "@/server/services/imports";

/** Commit a fully valid preview in one transaction (all rows or none). */
export const POST = staffRoute({ permission: "subscribers.import", params: uuidParam }, async ({ ctx, params }) => ({
  data: await commitSubscriberImport(ctx, params.id),
}));
