import { z } from "zod";
import { staffRoute, uuidParam } from "@/server/api/handler";
import { createPortalInviteLink, portalAccessStatus, sendPortalInvite, setPortalAccess } from "@/server/portal/auth";

export const GET = staffRoute({ permission: "subscribers.read", params: uuidParam }, async ({ ctx, params }) => ({ data: await portalAccessStatus(ctx, params.id) }));

const body = z.object({ action: z.enum(["invite", "link", "enable", "disable"]) });

/**
 * invite: send the setup link by SMS/email (token minted at send time);
 * link: return a one-time setup link to hand over directly (shown once, not stored);
 * enable/disable: toggle access (disable revokes sessions).
 */
export const POST = staffRoute({ permission: "subscribers.write", params: uuidParam, body }, async ({ ctx, params, body }) => {
  if (body.action === "invite") return { data: await sendPortalInvite(ctx, params.id) };
  if (body.action === "link") return { data: await createPortalInviteLink(ctx, params.id) };
  await setPortalAccess(ctx, params.id, body.action === "enable");
  return { data: { ok: true } };
});
