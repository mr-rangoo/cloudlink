import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { loginStaff, MAX_FAILED_LOGINS } from "@/server/auth/service";
import { resolveSession, revokeAllUserSessions } from "@/server/auth/session";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as logoutRoute } from "@/app/api/v1/auth/logout/route";
import { GET as sessionRoute } from "@/app/api/v1/auth/session/route";
import { createOrg, createStaff, noParams, request, sessionFor, TEST_PASSWORD } from "./fixtures";

const meta = { correlationId: "test-corr-0001", ipAddress: "10.1.1.1", userAgent: "vitest" };

describe("staff authentication", () => {
  it("logs in with valid credentials, sets a secure HTTP-only cookie and audits the event", async () => {
    const { owner, organization } = await createOrg();
    const res = await loginRoute(request("/api/v1/auth/login", { body: { email: owner.email.toUpperCase(), password: TEST_PASSWORD } }), noParams);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/cloudlink_session=/);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");

    const session = await db.session.findFirstOrThrow({ where: { userId: owner.id } });
    expect(session.organizationId).toBe(organization.id);
    expect(session.tokenHash).toHaveLength(64); // only the hash is stored
    expect(await db.auditLog.count({ where: { action: "auth.login", actorUserId: owner.id } })).toBe(1);
  });

  it("returns the same generic error for unknown users and wrong passwords", async () => {
    const { owner } = await createOrg();
    const a = await loginRoute(request("/api/v1/auth/login", { body: { email: "nobody@example.test", password: "whatever-123" } }), noParams);
    const b = await loginRoute(request("/api/v1/auth/login", { body: { email: owner.email, password: "wrong-password" } }), noParams);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const ja = await a.json();
    const jb = await b.json();
    expect(ja.error.message).toEqual(jb.error.message);
    expect(ja.error.correlationId).toBeTruthy();
    expect(await db.auditLog.count({ where: { action: "auth.login_failed" } })).toBe(2);
  });

  it("locks the account after repeated failures, even for the right password", async () => {
    const { owner } = await createOrg();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(loginStaff({ email: owner.email, password: "bad-password" }, { ...meta, ipAddress: `10.2.0.${i}` })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    const user = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(user.lockedUntil).not.toBeNull();
    await expect(loginStaff({ email: owner.email, password: TEST_PASSWORD }, { ...meta, ipAddress: "10.2.1.1" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await db.auditLog.count({ where: { action: "auth.account_locked" } })).toBe(1);
  });

  it("rate-limits login attempts per email", async () => {
    const { owner } = await createOrg();
    await db.user.update({ where: { id: owner.id }, data: { passwordHash: "scrypt$1$1$1$AA==$AA==" } }); // avoid lockout interference
    let limited = false;
    for (let i = 0; i < 12; i++) {
      try {
        await loginStaff({ email: owner.email, password: "x-password" }, { ...meta, ipAddress: `10.3.0.${i}` });
      } catch (err) {
        if ((err as { code?: string }).code === "RATE_LIMITED") limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it("counts only failed sign-ins toward the per-IP limit", async () => {
    const { owner } = await createOrg();
    const shared = { ...meta, ipAddress: "10.4.0.1" };
    for (let i = 0; i < 25; i++) await loginStaff({ email: owner.email, password: TEST_PASSWORD }, shared); // an office behind one NAT address
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      try {
        await loginStaff({ email: `nobody-${i}@example.test`, password: "wrong-password" }, shared);
      } catch (err) {
        if ((err as { code?: string }).code === "RATE_LIMITED") limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it("rejects disabled users and revokes sessions", async () => {
    const { organization } = await createOrg();
    const { user } = await createStaff(organization.id, "support");
    const token = await sessionFor(user.id, organization.id);
    expect(await resolveSession(token)).not.toBeNull();

    await db.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    expect(await resolveSession(token)).toBeNull(); // disabled user sessions stop working immediately
    await expect(loginStaff({ email: user.email, password: TEST_PASSWORD }, meta)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    await db.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
    expect(await revokeAllUserSessions(user.id)).toBe(1);
    expect(await resolveSession(token)).toBeNull();
  });

  it("logout revokes the server-side session", async () => {
    const { owner, organization } = await createOrg();
    const token = await sessionFor(owner.id, organization.id);
    const res = await logoutRoute(request("/api/v1/auth/logout", { method: "POST", token }), noParams);
    expect(res.status).toBe(200);
    expect(await resolveSession(token)).toBeNull();
    const after = await sessionRoute(request("/api/v1/auth/session", { token }), noParams);
    expect(after.status).toBe(401);
  });

  it("rejects expired sessions", async () => {
    const { owner, organization } = await createOrg();
    const token = await sessionFor(owner.id, organization.id);
    await db.session.updateMany({ where: { userId: owner.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(token)).toBeNull();
  });
});
