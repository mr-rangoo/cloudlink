import { NextResponse, type NextRequest } from "next/server";

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Edge of the request pipeline:
 * - assigns/propagates a correlation ID on every request and response;
 * - sends visitors without a session cookie to /login (a cheap pre-check only;
 *   real authentication and authorization happen server-side in every page and API handler).
 */
export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-correlation-id");
  const correlationId = incoming && CORRELATION_RE.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("x-correlation-id", correlationId);

  const { pathname } = req.nextUrl;
  const isPublic = pathname.startsWith("/api/") || pathname === "/login" || pathname.startsWith("/invite/") || pathname.startsWith("/portal") || pathname.startsWith("/hotspot");
  const hasSession = req.cookies.has("cloudlink_session") || req.cookies.has("__Host-cloudlink_session");

  if (!isPublic && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    const res = NextResponse.redirect(url);
    res.headers.set("x-correlation-id", correlationId);
    return res;
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-correlation-id", correlationId);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};
