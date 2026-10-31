import { type NextRequest } from "next/server";
import { getRequestMeta } from "@/server/api/handler";
import { isAppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import { agentCheckIn } from "@/server/services/router-link";

const MAX_BODY = 65_536;

/**
 * POST /api/v1/routers/agent/:key: a router's check-in from the Cloudlink agent (every minute).
 * No session: the per-router key is the authorization (stored hashed, rotated by each setup). The body is the router's
 * report; the answer is a RouterOS script the router imports (usually a comment, sometimes a change). Never cached.
 */
export async function POST(req: NextRequest, routeCtx: { params: Promise<{ key: string }> }): Promise<Response> {
  const meta = getRequestMeta(req);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-correlation-id": meta.correlationId, "x-content-type-options": "nosniff" };
  try {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return new Response("# Report too large.\n", { status: 413, headers });
    const body = (await req.text()).slice(0, MAX_BODY);
    const { key } = await routeCtx.params;
    const res = await agentCheckIn(key, body, meta);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    if (isAppError(err) && err.code === "RATE_LIMITED") return new Response("# Too many check-ins. Try again later.\n", { status: 429, headers });
    logger.error({ correlationId: meta.correlationId, err: err instanceof Error ? err.name : "unknown" }, "router check-in failed");
    return new Response("# Cloudlink could not process the check-in.\n", { status: 500, headers });
  }
}
