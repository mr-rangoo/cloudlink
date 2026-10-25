import { staffRoute } from "@/server/api/handler";
import { registerC2bUrls } from "@/server/services/mpesa-config";

/** Register C2B confirmation/validation URLs (with a new secret token) for direct paybill/till payments. */
export const POST = staffRoute({ permission: "integrations.write" }, async ({ ctx }) => ({ data: await registerC2bUrls(ctx) }));
