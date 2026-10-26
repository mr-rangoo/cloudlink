import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api/handler";
import { loginSchema, loginStaff } from "@/server/auth/service";
import { resolveSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { brandingFor } from "@/server/services/branding";
import { THEME_COOKIE, themeCookieOptions } from "@/lib/theme-cookie";

export const POST = publicRoute({ body: loginSchema, checkOrigin: true }, async ({ req, body, meta }) => {
  const session = await loginStaff(body, meta);
  const res = NextResponse.json({ data: { ok: true, expiresAt: session.expiresAt } });
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  if (!req.cookies.get(THEME_COOKIE)) {
    const resolved = await resolveSession(session.token);
    if (resolved?.organizationId) res.cookies.set(THEME_COOKIE, (await brandingFor(resolved.organizationId)).defaultMode, themeCookieOptions);
  }
  return res;
});
