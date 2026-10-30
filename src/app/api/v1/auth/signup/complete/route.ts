import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api/handler";
import { completeSignup, signupTokenInput } from "@/server/services/signup";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { THEME_COOKIE, themeCookieOptions } from "@/lib/theme-cookie";

/** Confirm a sign-up link: creates the workspace and owner, then signs the owner in. */
export const POST = publicRoute({ body: signupTokenInput, checkOrigin: true }, async ({ req, body, meta }) => {
  const { session, organization } = await completeSignup(body, meta);
  const res = NextResponse.json({ data: { organization } }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  if (!req.cookies.get(THEME_COOKIE)) res.cookies.set(THEME_COOKIE, "light", themeCookieOptions);
  return res;
});
