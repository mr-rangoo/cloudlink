import { staffRoute } from "@/server/api/handler";
import { trialBalance } from "@/server/services/ledger";

export const GET = staffRoute({ permission: "ledger.read" }, async ({ ctx }) => ({ data: await trialBalance(ctx) }));
