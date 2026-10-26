import { NextResponse } from "next/server";
import { customerRoute } from "@/server/api/handler";
import { PORTAL_COOKIE, portalLogout } from "@/server/portal/auth";
import { clearedCookieOptions } from "@/server/auth/session";

export const POST = customerRoute({}, async ({ ctx }) => {
  await portalLogout(ctx);
  const res = NextResponse.json({ data: { ok: true, organization: ctx.organization.slug } });
  res.cookies.set(PORTAL_COOKIE, "", clearedCookieOptions());
  return res;
});
