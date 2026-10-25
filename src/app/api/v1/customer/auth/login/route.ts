import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api/handler";
import { PORTAL_COOKIE, portalLogin, portalLoginInput } from "@/server/portal/auth";
import { sessionCookieOptions } from "@/server/auth/session";

export const POST = publicRoute({ body: portalLoginInput, checkOrigin: true }, async ({ body, meta }) => {
  const { token, expiresAt } = await portalLogin(body, meta);
  const res = NextResponse.json({ data: { ok: true, expiresAt } });
  res.cookies.set(PORTAL_COOKIE, token, sessionCookieOptions(expiresAt));
  // Non-sensitive convenience cookie: remembers which provider the customer uses for the portal entry page.
  res.cookies.set("cloudlink_portal_org", body.organization, { path: "/portal", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  return res;
});
