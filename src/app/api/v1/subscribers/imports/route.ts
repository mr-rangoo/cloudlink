import { staffRoute } from "@/server/api/handler";
import { importPreviewInput, listImportJobs, previewSubscriberImport } from "@/server/services/imports";

/** Upload CSV text for validation. Creates a preview job; nothing is imported until commit. */
export const POST = staffRoute({ permission: "subscribers.import", body: importPreviewInput }, async ({ ctx, body }) => ({
  data: await previewSubscriberImport(ctx, body),
  status: 201,
}));

export const GET = staffRoute({ permission: "subscribers.import" }, async ({ ctx }) => ({ data: await listImportJobs(ctx) }));
