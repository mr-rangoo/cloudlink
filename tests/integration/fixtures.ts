import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { createOrganizationWithOwner, ensureDefaultRoles } from "@/server/services/organizations";
import { hashPassword } from "@/server/security/crypto";
import { createSession, resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { loadStaffContext, type StaffContext } from "@/server/auth/context";

export const TEST_PASSWORD = "Test-Password-123!";
export const ORIGIN = "http://localhost:3100";

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createOrg(name = "Test ISP") {
  const id = uniq();
  return createOrganizationWithOwner({
    name: `${name} ${id}`,
    slug: `org-${id}`,
    branch: { name: "Main", code: "MAIN" },
    owner: { name: "Owner Person", email: `owner-${id}@example.test`, password: TEST_PASSWORD },
  });
}

export async function createStaff(organizationId: string, roleKey: string, opts: { branchIds?: string[]; email?: string } = {}) {
  const roles = await db.$transaction((tx) => ensureDefaultRoles(tx, organizationId));
  const user = await db.user.create({
    data: { name: `${roleKey} user`, email: opts.email ?? `${roleKey}-${uniq()}@example.test`, passwordHash: await hashPassword(TEST_PASSWORD) },
  });
  const membership = await db.membership.create({
    data: { organizationId, userId: user.id, allBranches: !opts.branchIds },
  });
  await db.membershipRole.create({ data: { membershipId: membership.id, roleId: roles[roleKey]! } });
  for (const branchId of opts.branchIds ?? []) await db.membershipBranch.create({ data: { membershipId: membership.id, branchId } });
  return { user, membership };
}

export async function sessionFor(userId: string, organizationId: string) {
  const { token } = await createSession(userId, organizationId, { ipAddress: "127.0.0.1", userAgent: "vitest" });
  return token;
}

export async function contextFor(userId: string, organizationId: string): Promise<StaffContext> {
  const token = await sessionFor(userId, organizationId);
  const session = await resolveSession(token);
  return loadStaffContext(session!, { correlationId: "test-correlation-id", ipAddress: "127.0.0.1", userAgent: "vitest" });
}

export function request(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; portalToken?: string; origin?: string | null; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(opts.headers);
  headers.set("host", "localhost:3100");
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.token) headers.set("cookie", `${SESSION_COOKIE}=${opts.token}`);
  if (opts.portalToken) headers.set("cookie", `cloudlink_portal=${opts.portalToken}`);
  headers.set("x-forwarded-for", headers.get("x-forwarded-for") ?? "10.0.0.1");
  return new NextRequest(new URL(path, ORIGIN), {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export const noParams = { params: Promise.resolve({}) };
