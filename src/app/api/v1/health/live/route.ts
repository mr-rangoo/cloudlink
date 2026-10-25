import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process is up. No dependency checks, no sensitive data. */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
