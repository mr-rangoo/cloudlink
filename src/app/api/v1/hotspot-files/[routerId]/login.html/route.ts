import { type NextRequest } from "next/server";
import { z } from "zod";
import { getRequestMeta } from "@/server/api/handler";
import { isAppError } from "@/server/errors";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { routerLoginPage } from "@/server/services/hotspot-sales";

/**
 * GET /api/v1/hotspot-files/:routerId/login.html — the router's hotspot login page (fetched by the router into its
 * hotspot directory). It only redirects to the organization's captive portal and contains no secrets.
 */
export async function GET(req: NextRequest, routeCtx: { params: Promise<{ routerId: string }> }): Promise<Response> {
  const meta = getRequestMeta(req);
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-correlation-id": meta.correlationId, "x-content-type-options": "nosniff" };
  try {
    const { routerId } = await routeCtx.params;
    if (!z.uuid().safeParse(routerId).success) return new Response("Not found\n", { status: 404, headers });
    await consumeRateLimit({ name: "hotspot:files:ip", limit: 60, windowSeconds: 600 }, meta.ipAddress ?? "unknown");
    const html = await routerLoginPage(routerId);
    return html ? new Response(html, { status: 200, headers }) : new Response("Not found\n", { status: 404, headers });
  } catch (err) {
    if (isAppError(err) && err.code === "RATE_LIMITED") return new Response("Too many requests\n", { status: 429, headers });
    return new Response("Error\n", { status: 500, headers });
  }
}
