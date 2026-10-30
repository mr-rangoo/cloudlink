import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getRequestMeta } from "@/server/api/handler";
import { isAppError } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import type { WebhookMeta, WebhookResponse } from "@/server/services/mobile-money";

/**
 * Provider webhook endpoint: no session, no same-origin check (the caller is the provider), raw body passed through
 * so it can be fingerprinted. Authenticity is the handler's job (secret URL token, identifiers, provider query).
 * Responses never echo request content and are never cached.
 */
export function webhookRoute(handler: (token: string, rawBody: string, meta: WebhookMeta) => Promise<WebhookResponse>, opts: { signatureHeader?: string } = {}) {
  return async (req: NextRequest, routeCtx: { params: Promise<{ token: string }> }): Promise<Response> => {
    const meta: WebhookMeta = { ...getRequestMeta(req), signature: opts.signatureHeader ? req.headers.get(opts.signatureHeader) : null };
    const headers = { "cache-control": "no-store", "x-correlation-id": meta.correlationId };
    try {
      const { token } = await routeCtx.params;
      const raw = await req.text();
      const res = await handler(token, raw, meta);
      return NextResponse.json(res.body, { status: res.status, headers });
    } catch (err) {
      if (isAppError(err) && err.code === "RATE_LIMITED") return NextResponse.json({ ResultCode: 1, ResultDesc: "Rate limited" }, { status: 429, headers });
      logger.error({ correlationId: meta.correlationId, err: err instanceof Error ? err.name : "unknown" }, "webhook handling failed");
      return NextResponse.json({ ResultCode: 1, ResultDesc: "Temporary error" }, { status: 500, headers });
    }
  };
}
