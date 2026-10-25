import { staffRoute } from "@/server/api/handler";
import { batchInput, generateBatch, listBatches } from "@/server/services/vouchers";

export const GET = staffRoute({ permission: "vouchers.read" }, async ({ ctx }) => ({ data: await listBatches(ctx) }));

/** Generate a batch. The response contains the plaintext codes ONCE; afterwards only audited exports reveal them. */
export const POST = staffRoute({ permission: "vouchers.write", body: batchInput, requireIdempotencyKey: true }, async ({ ctx, body }) => ({ data: await generateBatch(ctx, body), status: 201 }));
