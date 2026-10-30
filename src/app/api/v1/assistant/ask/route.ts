import { staffRoute } from "@/server/api/handler";
import { askStaff, staffAskInput } from "@/server/assistant/staff";

/** Ask AI: a question about the organization, answered from records the asking staff member may see. */
export const POST = staffRoute({ permission: "dashboard.view", body: staffAskInput }, async ({ ctx, body }) => ({ data: await askStaff(ctx, body) }));
