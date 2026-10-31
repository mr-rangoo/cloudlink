import { type NextRequest } from "next/server";
import { getRequestMeta } from "@/server/api/handler";
import { isAppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import { agentResult } from "@/server/services/router-link";

/** POST /api/v1/routers/agent/:key/result: the router confirms (or reports failure of) a change it imported. */
export async function POST(req: NextRequest, routeCtx: { params: Promise<{ key: string }> }): Promise<Response> {
  const meta = getRequestMeta(req);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-correlation-id": meta.correlationId, "x-content-type-options": "nosniff" };
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 1024) return new Response("too large\n", { status: 413, headers });
    const body = (await req.text()).slice(0, 1024);
    const { key } = await routeCtx.params;
    const res = await agentResult(key, body, meta);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    if (isAppError(err) && err.code === "RATE_LIMITED") return new Response("too many requests\n", { status: 429, headers });
    logger.error({ correlationId: meta.correlationId, err: err instanceof Error ? err.name : "unknown" }, "router change result failed");
    return new Response("error\n", { status: 500, headers });
  }
}
