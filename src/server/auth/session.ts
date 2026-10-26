import "server-only";
import { db } from "@/server/db/client";
import { randomToken, sha256 } from "@/server/security/crypto";

export const SESSION_COOKIE = process.env.APP_ENV === "production" ? "__Host-cloudlink_session" : "cloudlink_session";
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function sessionTtlMs(): number {
  return Number(process.env.SESSION_TTL_HOURS ?? 12) * 60 * 60 * 1000;
}

export interface SessionMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function createSession(
  userId: string,
  organizationId: string | null,
  meta: SessionMeta,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + sessionTtlMs());
  const session = await db.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      organizationId,
      ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
      expiresAt,
    },
  });
  return { token, sessionId: session.id, expiresAt };
}

/** Resolve a raw cookie token to a live session with an active user, or null. */
export async function resolveSession(token: string | undefined | null) {
  if (!token || token.length > 128) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, name: true, email: true, kind: true, status: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.revokedAt || session.expiresAt.getTime() <= now) return null;
  if (session.user.status !== "ACTIVE") return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }
  return session;
}

export type ResolvedSession = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

export async function revokeSession(sessionId: string): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Used when a user is disabled, their password changes, or their permissions change materially. */
export async function revokeAllUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const res = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** Clearing a cookie must repeat its Secure flag, or browsers ignore it for __Host- cookies. */
export function clearedCookieOptions() {
  const { expires: _unused, ...rest } = sessionCookieOptions(new Date(0));
  void _unused;
  return { ...rest, maxAge: 0 };
}

export function sessionCookieOptions(expiresAt: Date) {
  const secure = process.env.APP_ENV === "production" || (process.env.APP_URL ?? "").startsWith("https://");
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}
