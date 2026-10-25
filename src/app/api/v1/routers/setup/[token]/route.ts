import { type NextRequest } from "next/server";
import { getRequestMeta } from "@/server/api/handler";
import { isAppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import { serveSetupScript } from "@/server/services/router-setup";

/**
 * GET /api/v1/routers/setup/:token: the router downloads its one-time setup script (RouterOS .rsc).
 * No session: the single-use, 30-minute token is the authorization. The body contains a password and is never cached
 * or logged.
 */
export async function GET(req: NextRequest, routeCtx: { params: Promise<{ token: string }> }): Promise<Response> {
  const meta = getRequestMeta(req);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-correlation-id": meta.correlationId, "x-content-type-options": "nosniff" };
  try {
    const { token } = await routeCtx.params;
    const res = await serveSetupScript(token, meta);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    if (isAppError(err) && err.code === "RATE_LIMITED") return new Response("# Too many attempts. Try again later.\n", { status: 429, headers });
    logger.error({ correlationId: meta.correlationId, err: err instanceof Error ? err.name : "unknown" }, "router setup script failed");
    return new Response("# Cloudlink could not prepare the setup script. Try again.\n", { status: 500, headers });
  }
}
