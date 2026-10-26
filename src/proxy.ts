import { NextResponse, type NextRequest } from "next/server";

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Content-Security-Policy with a per-request nonce (Next.js applies it to its own scripts).
 * - Scripts: only this origin's nonce-bearing scripts ('strict-dynamic' lets them load their chunks).
 * - Styles allow inline attributes (layout widths, chart colours); no inline scripts anywhere.
 * - Forms post to this origin only, except the captive portal, which hands the voucher to the hotspot router's own
 *   login URL (validated server-side to be a private address).
 */
export function contentSecurityPolicy(nonce: string, pathname: string, opts: { dev: boolean; https: boolean }): string {
  if (pathname.startsWith("/api/")) return "default-src 'none'; frame-ancestors 'none'";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${opts.dev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    `form-action ${pathname.startsWith("/hotspot") ? "'self' http: https:" : "'self'"}`,
    "base-uri 'self'",
    "object-src 'none'",
  ];
  if (opts.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/**
 * Edge of the request pipeline:
 * - assigns/propagates a correlation ID on every request and response;
 * - sets the Content-Security-Policy (with a fresh nonce) and, in production, HSTS;
 * - sends visitors without a session cookie to /login (a cheap pre-check only;
 *   real authentication and authorization happen server-side in every page and API handler).
 */
export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-correlation-id");
  const correlationId = incoming && CORRELATION_RE.test(incoming) ? incoming : crypto.randomUUID();
  const { pathname } = req.nextUrl;
  const production = process.env.APP_ENV === "production";
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, pathname, { dev: process.env.NODE_ENV !== "production", https: (process.env.APP_URL ?? "").startsWith("https://") });

  const headers = new Headers(req.headers);
  headers.set("x-correlation-id", correlationId);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const decorate = (res: NextResponse) => {
    res.headers.set("x-correlation-id", correlationId);
    res.headers.set("content-security-policy", csp);
    if (production) res.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
    return res;
  };

  const isPublic = pathname.startsWith("/api/") || pathname === "/login" || pathname.startsWith("/invite/") || pathname.startsWith("/portal") || pathname.startsWith("/hotspot");
  const hasSession = req.cookies.has("cloudlink_session") || req.cookies.has("__Host-cloudlink_session");

  if (!isPublic && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return decorate(NextResponse.redirect(url));
  }

  return decorate(NextResponse.next({ request: { headers } }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};
