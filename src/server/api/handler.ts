import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { AppError, isAppError, toEnvelope, type FieldIssue } from "@/server/errors";
import { logger } from "@/server/observability/logger";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { loadStaffContext, requirePermission, type CustomerContext, type RequestMeta, type StaffContext } from "@/server/auth/context";
import { PORTAL_COOKIE, resolveCustomerContext } from "@/server/portal/auth";
import type { PermissionKey } from "@/server/auth/permissions";
import { Prisma } from "@/generated/prisma/client";
import { withIdempotency } from "@/server/api/idempotency";

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_BODY_BYTES = 1_000_000;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function getRequestMeta(req: Request): RequestMeta {
  const incoming = req.headers.get("x-correlation-id");
  const correlationId = incoming && CORRELATION_RE.test(incoming) ? incoming : crypto.randomUUID();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ipAddress = forwarded || req.headers.get("x-real-ip") || null;
  return { correlationId, ipAddress, userAgent: req.headers.get("user-agent") };
}

/**
 * CSRF defence for cookie-authenticated mutations: require an Origin (or Referer) header
 * matching this deployment. SameSite=Lax cookies provide a second layer.
 */
export function assertSameOrigin(req: Request): void {
  const allowed = new Set<string>();
  const appUrl = process.env.APP_URL;
  if (appUrl) allowed.add(new URL(appUrl).origin);
  const host = req.headers.get("host");
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  if (!origin || !allowed.has(origin)) throw new AppError("BAD_ORIGIN");
}

function zodFields(err: ZodError): FieldIssue[] {
  return err.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function errorResponse(err: unknown, correlationId: string): NextResponse {
  let appErr: AppError;
  if (isAppError(err)) appErr = err;
  else if (err instanceof ZodError) appErr = new AppError("VALIDATION_ERROR", undefined, { fields: zodFields(err) });
  else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    appErr = new AppError("CONFLICT", "A record with these details already exists.");
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    appErr = new AppError("NOT_FOUND");
  } else {
    appErr = new AppError("INTERNAL_ERROR", undefined, { cause: err });
  }

  const logPayload = { correlationId, code: appErr.code, status: appErr.status, details: appErr.details };
  if (appErr.status >= 500) logger.error({ ...logPayload, err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, "request failed");
  else logger.info(logPayload, "request rejected");

  const res = NextResponse.json(toEnvelope(appErr, correlationId), { status: appErr.status });
  res.headers.set("x-correlation-id", correlationId);
  if (appErr.retryAfterSeconds) res.headers.set("retry-after", String(appErr.retryAfterSeconds));
  return res;
}

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw new AppError("VALIDATION_ERROR", "Request body is too large.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new AppError("VALIDATION_ERROR", "Request body is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

type RouteParams = { params: Promise<Record<string, string | string[]>> };

interface BaseArgs<B, Q, P> {
  req: NextRequest;
  meta: RequestMeta;
  body: B;
  query: Q;
  params: P;
}

export interface StaffArgs<B, Q, P> extends BaseArgs<B, Q, P> {
  ctx: StaffContext;
  idempotencyKey: string | null;
}

type Result = NextResponse | Response | { data: unknown; status?: number; pagination?: unknown };

function toResponse(result: Result, correlationId: string): Response {
  if (result instanceof Response) {
    result.headers.set("x-correlation-id", correlationId);
    return result;
  }
  const { status = 200, ...body } = result;
  const res = NextResponse.json(body, { status });
  res.headers.set("x-correlation-id", correlationId);
  res.headers.set("cache-control", "no-store");
  return res;
}

interface Schemas<B extends ZodType, Q extends ZodType, P extends ZodType> {
  body?: B;
  query?: Q;
  params?: P;
}

async function parseInputs<B extends ZodType, Q extends ZodType, P extends ZodType>(req: NextRequest, routeCtx: RouteParams | undefined, s: Schemas<B, Q, P>) {
  const rawParams = routeCtx ? await routeCtx.params : {};
  const params = s.params ? s.params.parse(rawParams) : rawParams;
  const query = s.query ? s.query.parse(Object.fromEntries(req.nextUrl.searchParams)) : {};
  const body = s.body ? s.body.parse(await readJson(req)) : undefined;
  return { params, query, body } as { params: z.output<P>; query: z.output<Q>; body: z.output<B> };
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Authenticated staff endpoint with permission check, validation and the standard error envelope. */
export function staffRoute<B extends ZodType = ZodType<undefined>, Q extends ZodType = ZodType<unknown>, P extends ZodType = ZodType<unknown>>(
  opts: Schemas<B, Q, P> & {
    permission?: PermissionKey | PermissionKey[];
    requireIdempotencyKey?: boolean;
    /** The response contains a secret: never persist it in the idempotency store (the key is ignored). */
    secretResponse?: boolean;
  },
  fn: (args: StaffArgs<z.output<B>, z.output<Q>, z.output<P>>) => Promise<Result>,
) {
  return async (req: NextRequest, routeCtx?: RouteParams): Promise<Response> => {
    const meta = getRequestMeta(req);
    try {
      if (UNSAFE_METHODS.has(req.method)) assertSameOrigin(req);
      const session = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
      if (!session) throw new AppError("UNAUTHENTICATED");
      const ctx = await loadStaffContext(session, meta);
      if (opts.permission) requirePermission(ctx, ...(Array.isArray(opts.permission) ? opts.permission : [opts.permission]));

      const rawKey = req.headers.get("idempotency-key");
      if (rawKey && !IDEMPOTENCY_RE.test(rawKey)) throw new AppError("VALIDATION_ERROR", "Idempotency-Key header is malformed.");
      if (opts.requireIdempotencyKey && !rawKey) throw new AppError("VALIDATION_ERROR", "An Idempotency-Key header is required for this operation.");

      const { params, query, body } = await parseInputs(req, routeCtx, opts);
      const run = () => fn({ req, meta, ctx, params, query, body, idempotencyKey: rawKey });
      if (!rawKey || !UNSAFE_METHODS.has(req.method) || opts.secretResponse) return toResponse(await run(), meta.correlationId);

      // Idempotent execution: the same key + same body replays the stored response.
      const scope = `org:${ctx.organizationId}:${req.method}:${req.nextUrl.pathname}`;
      const outcome = await withIdempotency(scope, rawKey, `${ctx.userId}|${JSON.stringify(body ?? null)}`, ctx.organizationId, async () => {
        const res = toResponse(await run(), meta.correlationId);
        const text = await res.clone().text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      });
      const payload =
        outcome.status >= 400 && outcome.body && typeof outcome.body === "object" && "error" in outcome.body
          ? { error: { ...(outcome.body as { error: object }).error, correlationId: meta.correlationId } }
          : outcome.body;
      const res = NextResponse.json(payload, { status: outcome.status });
      res.headers.set("x-correlation-id", meta.correlationId);
      res.headers.set("cache-control", "no-store");
      if (outcome.replayed) res.headers.set("idempotent-replayed", "true");
      return res;
    } catch (err) {
      return errorResponse(err, meta.correlationId);
    }
  };
}

export interface CustomerArgs<B, Q, P> extends BaseArgs<B, Q, P> {
  ctx: CustomerContext;
}

/**
 * Customer-portal endpoint. The context is bound to one subscriber; handlers must scope every query by
 * `ctx.subscriberId` and never accept a subscriber id from the request.
 */
export function customerRoute<B extends ZodType = ZodType<undefined>, Q extends ZodType = ZodType<unknown>, P extends ZodType = ZodType<unknown>>(
  opts: Schemas<B, Q, P>,
  fn: (args: CustomerArgs<z.output<B>, z.output<Q>, z.output<P>>) => Promise<Result>,
) {
  return async (req: NextRequest, routeCtx?: RouteParams): Promise<Response> => {
    const meta = getRequestMeta(req);
    try {
      if (UNSAFE_METHODS.has(req.method)) assertSameOrigin(req);
      const ctx = await resolveCustomerContext(req.cookies.get(PORTAL_COOKIE)?.value, meta);
      if (!ctx) throw new AppError("UNAUTHENTICATED");
      const { params, query, body } = await parseInputs(req, routeCtx, opts);
      return toResponse(await fn({ req, meta, ctx, params, query, body }), meta.correlationId);
    } catch (err) {
      return errorResponse(err, meta.correlationId);
    }
  };
}

/** Read a single uploaded file from multipart form data with a hard size limit. */
export async function readUploadedFile(req: Request, field = "file", maxBytes = 5 * 1024 * 1024 + 64 * 1024): Promise<{ name: string; data: Buffer }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes + 16 * 1024) throw new AppError("VALIDATION_ERROR", "Files must be 5 MB or smaller.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Upload a file using multipart/form-data.");
  }
  const file = form.get(field);
  if (!file || typeof file === "string") throw new AppError("VALIDATION_ERROR", "No file was uploaded.");
  if (file.size > maxBytes) throw new AppError("VALIDATION_ERROR", "Files must be 5 MB or smaller.");
  return { name: file.name, data: Buffer.from(await file.arrayBuffer()) };
}

/** Unauthenticated endpoint (login, health, webhooks). Callers must add their own protections. */
export function publicRoute<B extends ZodType = ZodType<undefined>, Q extends ZodType = ZodType<unknown>, P extends ZodType = ZodType<unknown>>(
  opts: Schemas<B, Q, P> & { checkOrigin?: boolean },
  fn: (args: BaseArgs<z.output<B>, z.output<Q>, z.output<P>>) => Promise<Result>,
) {
  return async (req: NextRequest, routeCtx?: RouteParams): Promise<Response> => {
    const meta = getRequestMeta(req);
    try {
      if (opts.checkOrigin && UNSAFE_METHODS.has(req.method)) assertSameOrigin(req);
      const { params, query, body } = await parseInputs(req, routeCtx, opts);
      return toResponse(await fn({ req, meta, params, query, body }), meta.correlationId);
    } catch (err) {
      return errorResponse(err, meta.correlationId);
    }
  };
}

// ───────── Pagination ─────────
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function pageArgs(p: { page: number; pageSize: number }) {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}

export function paginated<T>(data: T[], total: number, p: { page: number; pageSize: number }) {
  return { data, pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) } };
}

export const uuidParam = z.object({ id: z.uuid() });
