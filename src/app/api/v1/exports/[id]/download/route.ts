import { staffRoute, uuidParam } from "@/server/api/handler";
import { downloadExport } from "@/server/services/exports";

export const runtime = "nodejs";

export const GET = staffRoute({ permission: "reports.export", params: uuidParam }, async ({ ctx, params }) => {
  const { data, fileName } = await downloadExport(ctx, params.id);
  return new Response(new Uint8Array(data), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});
