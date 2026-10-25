import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api/handler";
import { loginSchema, loginStaff } from "@/server/auth/service";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";

export const POST = publicRoute({ body: loginSchema, checkOrigin: true }, async ({ body, meta }) => {
  const session = await loginStaff(body, meta);
  const res = NextResponse.json({ data: { ok: true, expiresAt: session.expiresAt } });
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  return res;
});
