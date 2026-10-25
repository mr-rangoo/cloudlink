import { staffRoute } from "@/server/api/handler";
import { inviteStaff, listStaff, staffInviteInput } from "@/server/services/admin";

export const GET = staffRoute({ permission: "staff.read" }, async ({ ctx }) => ({ data: await listStaff(ctx) }));

/** Invite staff. New users receive a single-use setup link (returned once, never stored in plaintext). */
export const POST = staffRoute({ permission: "staff.write", body: staffInviteInput }, async ({ ctx, body }) => ({ data: await inviteStaff(ctx, body), status: 201 }));
