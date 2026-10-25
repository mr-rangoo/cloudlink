import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { loadStaffContext, requirePermission, type StaffContext } from "@/server/auth/context";
import type { PermissionKey } from "@/server/auth/permissions";
import { isAppError } from "@/server/errors";

/**
 * Resolve the staff context for a server component. Cached per request so layouts and pages share it.
 * Redirects to /login when the session is missing or no longer valid.
 */
export const getStaffContext = cache(async (): Promise<StaffContext> => {
  const cookieStore = await cookies();
  const h = await headers();
  const session = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  try {
    return await loadStaffContext(session, {
      correlationId: h.get("x-correlation-id") ?? crypto.randomUUID(),
      ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: h.get("user-agent"),
    });
  } catch (err) {
    if (isAppError(err) && err.code === "FORBIDDEN") redirect("/login?reason=access");
    throw err;
  }
});

/** For pages: returns context or renders the 403 page via `forbidden` result. */
export async function getStaffContextWith(permission: PermissionKey): Promise<{ ctx: StaffContext; allowed: boolean }> {
  const ctx = await getStaffContext();
  try {
    requirePermission(ctx, permission);
    return { ctx, allowed: true };
  } catch {
    return { ctx, allowed: false };
  }
}
