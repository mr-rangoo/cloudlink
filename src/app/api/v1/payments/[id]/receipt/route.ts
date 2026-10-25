import { staffRoute, uuidParam } from "@/server/api/handler";
import { pdfResponse, receiptPdf } from "@/server/services/documents";

export const runtime = "nodejs";

export const GET = staffRoute({ permission: "payments.read", params: uuidParam }, async ({ ctx, params, req }) => {
  const { pdf, filename } = await receiptPdf(ctx, params.id);
  return pdfResponse(pdf, filename, req.nextUrl.searchParams.get("download") !== "1");
});
