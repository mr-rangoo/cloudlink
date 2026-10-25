/**
 * Deterministic fictional fixtures for Playwright. Truncates the e2e database (name must end in _e2e).
 */
import "dotenv/config";
import { E2E_USERS, E2E_PASSWORD } from "./users";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!new URL(url).pathname.endsWith("_e2e")) throw new Error("seed-e2e only runs against an _e2e database");
  const { db, disconnectDb } = await import("@/server/db/client");
  const { createOrganizationWithOwner, ensureDefaultRoles } = await import("@/server/services/organizations");
  const { hashPassword } = await import("@/server/security/crypto");

  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);

  const alpha = await createOrganizationWithOwner({
    name: "Alpha Net (E2E)",
    slug: "alpha-e2e",
    branch: { name: "Central", code: "CEN" },
    owner: { name: "Olive Owner", email: E2E_USERS.owner, password: E2E_PASSWORD },
  });
  await createOrganizationWithOwner({
    name: "Bravo Net (E2E)",
    slug: "bravo-e2e",
    branch: { name: "North", code: "NTH" },
    owner: { name: "Ben Bravo", email: E2E_USERS.otherOwner, password: E2E_PASSWORD },
  });

  const east = await db.branch.create({ data: { organizationId: alpha.organization.id, name: "East", code: "EST" } });
  const roles = await db.$transaction((tx) => ensureDefaultRoles(tx, alpha.organization.id));
  const passwordHash = await hashPassword(E2E_PASSWORD);
  const cashier = await db.user.create({ data: { name: "Cara Cashier", email: E2E_USERS.cashier, passwordHash } });
  const m = await db.membership.create({ data: { organizationId: alpha.organization.id, userId: cashier.id, allBranches: false } });
  await db.membershipRole.create({ data: { membershipId: m.id, roleId: roles.cashier! } });
  await db.membershipBranch.create({ data: { membershipId: m.id, branchId: east.id } });
  const accountant = await db.user.create({ data: { name: "Abel Accountant", email: E2E_USERS.accountant, passwordHash } });
  const am = await db.membership.create({ data: { organizationId: alpha.organization.id, userId: accountant.id } });
  await db.membershipRole.create({ data: { membershipId: am.id, roleId: roles.accountant! } });

  await disconnectDb();
  console.log("e2e fixtures ready");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
