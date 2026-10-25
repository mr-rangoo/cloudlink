import { customerRoute, uuidParam } from "@/server/api/handler";
import { customerReceiptPdf } from "@/server/portal/services";
import { pdfResponse } from "@/server/services/documents";

export const runtime = "nodejs";

export const GET = customerRoute({ params: uuidParam }, async ({ ctx, params }) => {
  const { pdf, filename } = await customerReceiptPdf(ctx, params.id);
  return pdfResponse(pdf, filename);
});
