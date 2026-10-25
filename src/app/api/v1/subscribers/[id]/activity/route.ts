import { staffRoute, uuidParam } from "@/server/api/handler";
import { addSubscriberNote, listSubscriberActivity, noteInput } from "@/server/services/subscribers";

export const GET = staffRoute({ permission: "subscribers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await listSubscriberActivity(ctx, params.id) }));

/** Add a staff note to the subscriber timeline. */
export const POST = staffRoute({ permission: "subscribers.write", params: uuidParam, body: noteInput }, async ({ ctx, params, body }) => ({
  data: await addSubscriberNote(ctx, params.id, body.message),
  status: 201,
}));
