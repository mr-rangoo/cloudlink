import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { collectionsSummary } from "@/server/services/finance";

const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

export const GET = staffRoute({ permission: "expenses.read", query }, async ({ ctx, query }) => ({ data: await collectionsSummary(ctx, query.month) }));
