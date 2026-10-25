import { NextResponse } from "next/server";
import { staffRoute } from "@/server/api/handler";
import { logout } from "@/server/auth/service";
import { SESSION_COOKIE } from "@/server/auth/session";

export const POST = staffRoute({}, async ({ ctx }) => {
  await logout(ctx);
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0, sameSite: "lax" });
  return res;
});
