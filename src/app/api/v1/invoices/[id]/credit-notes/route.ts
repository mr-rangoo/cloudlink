import { staffRoute, uuidParam } from "@/server/api/handler";
import { createCreditNote, creditNoteInput } from "@/server/services/invoices";

export const POST = staffRoute({ permission: "credit_notes.create", params: uuidParam, body: creditNoteInput, requireIdempotencyKey: true }, async ({ ctx, params, body }) => ({
  data: await createCreditNote(ctx, params.id, body),
  status: 201,
}));
