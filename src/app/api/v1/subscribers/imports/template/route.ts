import { staffRoute } from "@/server/api/handler";
import { IMPORT_TEMPLATE } from "@/server/services/imports";

export const GET = staffRoute({ permission: "subscribers.import" }, async () => {
  return new Response(IMPORT_TEMPLATE, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="cloudlink-subscriber-import-template.csv"' },
  });
});
