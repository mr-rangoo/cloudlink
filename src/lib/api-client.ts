"use client";

/** Browser-side JSON client for the Cloudlink API. Errors surface the server's safe message and correlation ID. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
    public readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      signal: init.signal,
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", "Could not reach the server. Check your connection and try again.", 0);
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const e = (json.error ?? {}) as { code?: string; message?: string; correlationId?: string; fields?: Array<{ path: string; message: string }> };
    throw new ApiError(e.code ?? "HTTP_ERROR", e.message ?? `Request failed (${res.status})`, res.status, e.correlationId, e.fields);
  }
  return json as T;
}

export function newIdempotencyKey(prefix = "ui"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.fields) return {};
  return Object.fromEntries(err.fields.map((f) => [f.path, f.message]));
}
