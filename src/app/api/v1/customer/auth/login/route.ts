import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api/handler";
import { PORTAL_COOKIE, portalLogin, portalLoginInput } from "@/server/portal/auth";
import { sessionCookieOptions } from "@/server/auth/session";
import { brandingForSlug } from "@/server/services/branding";
import { THEME_COOKIE, themeCookieOptions } from "@/lib/theme-cookie";

export const POST = publicRoute({ body: portalLoginInput, checkOrigin: true }, async ({ req, body, meta }) => {
  const { token, expiresAt } = await portalLogin(body, meta);
  const res = NextResponse.json({ data: { ok: true, expiresAt } });
  res.cookies.set(PORTAL_COOKIE, token, sessionCookieOptions(expiresAt));
  // Non-sensitive convenience cookie: remembers which provider the customer uses for the portal entry page.
  res.cookies.set("cloudlink_portal_org", body.organization, { path: "/portal", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  if (!req.cookies.get(THEME_COOKIE)) {
    const branding = await brandingForSlug(body.organization);
    if (branding) res.cookies.set(THEME_COOKIE, branding.defaultMode, themeCookieOptions);
  }
  return res;
});
