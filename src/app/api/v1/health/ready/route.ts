import { NextResponse } from "next/server";
import { checkReadiness } from "@/server/observability/health";

export const dynamic = "force-dynamic";

/**
 * Readiness: database must be reachable. Redis is reported but not required, because the
 * worker falls back to database polling. Only coarse statuses are exposed publicly.
 */
export async function GET() {
  const result = await checkReadiness();
  return NextResponse.json(
    { status: result.ready ? "ready" : "not_ready", checks: result.checks },
    { status: result.ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
