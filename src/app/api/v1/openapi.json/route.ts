import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/server/api/openapi";

export const dynamic = "force-dynamic";

/** OpenAPI 3.1 description of the Cloudlink API (contract only; contains no tenant data). */
export function GET() {
  return NextResponse.json(buildOpenApiDocument(), { headers: { "cache-control": "no-store" } });
}
