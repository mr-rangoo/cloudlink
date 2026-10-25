import { staffRoute, uuidParam } from "@/server/api/handler";
import { exportBatchCodes } from "@/server/services/vouchers";
import { renderVoucherCards } from "@/server/documents/pdf";
import { csvCell } from "@/server/domain/csv";
import { formatCode } from "@/server/domain/vouchers";
import { describeInterval } from "@/server/domain/billing-period";
import { formatDate, formatMoney } from "@/lib/utils";

export const runtime = "nodejs";

/** Controlled export of UNUSED codes as printable PDF cards (default) or CSV. Audited and counted. */
export const GET = staffRoute({ permission: "vouchers.export", params: uuidParam }, async ({ ctx, params, req }) => {
  const { batch, codes } = await exportBatchCodes(ctx, params.id);
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
  if (req.nextUrl.searchParams.get("format") === "csv") {
    const csv = ["code,package,duration,price,expires", ...codes.map((c) => [formatCode(c), batch.packageName, describeInterval(batch.durationUnit, batch.durationCount), batch.faceValue.toString(), batch.expiresAt?.toISOString() ?? ""].map(csvCell).join(","))].join("\r\n");
    return new Response(csv, { headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${batch.batchNumber}.csv"` } });
  }
  const pdf = await renderVoucherCards({
    organization: ctx.organization.name,
    packageName: batch.packageName,
    duration: describeInterval(batch.durationUnit, batch.durationCount),
    price: formatMoney(batch.faceValue.toString(), batch.currency),
    expiresAt: batch.expiresAt ? formatDate(batch.expiresAt, ctx.organization.timezone) : null,
    portalUrl: `${process.env.APP_URL ?? ""}/hotspot/${ctx.organization.slug}`,
    codes,
  });
  return new Response(new Uint8Array(pdf), { headers: { ...headers, "content-type": "application/pdf", "content-disposition": `attachment; filename="${batch.batchNumber}.pdf"` } });
});
