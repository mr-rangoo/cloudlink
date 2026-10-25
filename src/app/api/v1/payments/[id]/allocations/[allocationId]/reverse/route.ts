import { z } from "zod";
import { staffRoute } from "@/server/api/handler";
import { reverseAllocation, reverseInput } from "@/server/services/payments";

const params = z.object({ id: z.uuid(), allocationId: z.uuid() });

export const POST = staffRoute({ permission: "payments.reconcile", params, body: reverseInput }, async ({ ctx, params, body }) => ({
  data: await reverseAllocation(ctx, params.id, params.allocationId, body.reason),
}));
