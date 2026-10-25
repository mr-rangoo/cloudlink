/**
 * Development seed. Creates two fictional organizations (to exercise tenant isolation) with
 * staff in several roles. Refuses to run in production or when ENABLE_DEMO_SEED is not true.
 *
 * All records are fictional demo data. Passwords come from SEED_PASSWORD or a printed random value.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to seed demo data in production.");
  if (process.env.ENABLE_DEMO_SEED !== "true") throw new Error("ENABLE_DEMO_SEED is not true; refusing to seed demo data.");

  const { db, disconnectDb } = await import("@/server/db/client");
  const { createOrganizationWithOwner, syncPermissionCatalogue, ensureDefaultRoles } = await import("@/server/services/organizations");
  const { hashPassword } = await import("@/server/security/crypto");

  const password = process.env.SEED_PASSWORD ?? `Demo-${randomBytes(6).toString("base64url")}`;
  await syncPermissionCatalogue();

  const orgs = [
    { name: "Skyline Fibre (Demo)", slug: "skyline-demo", branch: { name: "Nairobi CBD", code: "NBO" }, owner: { name: "Amina Wanjiru", email: "owner@skyline.demo" } },
    { name: "Lakeside Wireless (Demo)", slug: "lakeside-demo", branch: { name: "Kisumu", code: "KSM" }, owner: { name: "Brian Otieno", email: "owner@lakeside.demo" } },
  ];

  for (const o of orgs) {
    const existing = await db.organization.findUnique({ where: { slug: o.slug } });
    if (existing) {
      console.log(`• ${o.name} already exists, skipping`);
      continue;
    }
    const { organization } = await createOrganizationWithOwner({ ...o, owner: { ...o.owner, password } });
    console.log(`• created ${organization.name}`);
  }

  // Extra staff in Skyline with different roles, plus a second branch with a branch-restricted cashier.
  const skyline = await db.organization.findUniqueOrThrow({ where: { slug: "skyline-demo" } });
  const westlands = await db.branch.upsert({
    where: { organizationId_code: { organizationId: skyline.id, code: "WLD" } },
    update: {},
    create: { organizationId: skyline.id, name: "Westlands", code: "WLD" },
  });
  const roles = await db.$transaction((tx) => ensureDefaultRoles(tx, skyline.id));
  const staff = [
    { name: "Grace Muthoni", email: "accountant@skyline.demo", role: "accountant", branches: null },
    { name: "Peter Kamau", email: "cashier.wld@skyline.demo", role: "cashier", branches: [westlands.id] },
    { name: "Daniel Kiprop", email: "tech@skyline.demo", role: "technician", branches: null },
    { name: "Faith Achieng", email: "support@skyline.demo", role: "support", branches: null },
    { name: "Kevin Mwangi", email: "sales@skyline.demo", role: "sales", branches: null },
  ];
  const passwordHash = await hashPassword(password);
  for (const s of staff) {
    const user = await db.user.upsert({ where: { email: s.email }, update: {}, create: { name: s.name, email: s.email, passwordHash } });
    const membership = await db.membership.upsert({
      where: { organizationId_userId: { organizationId: skyline.id, userId: user.id } },
      update: {},
      create: { organizationId: skyline.id, userId: user.id, allBranches: s.branches === null },
    });
    await db.membershipRole.upsert({
      where: { membershipId_roleId: { membershipId: membership.id, roleId: roles[s.role]! } },
      update: {},
      create: { membershipId: membership.id, roleId: roles[s.role]! },
    });
    for (const branchId of s.branches ?? []) {
      await db.membershipBranch.upsert({ where: { membershipId_branchId: { membershipId: membership.id, branchId } }, update: {}, create: { membershipId: membership.id, branchId } });
    }
  }

  console.log("\nDemo staff accounts (fictional):");
  for (const e of [...orgs.map((o) => o.owner.email), ...staff.map((s) => s.email)]) console.log(`  ${e}`);
  console.log(
    process.env.SEED_PASSWORD
      ? "Password: value of SEED_PASSWORD (newly created accounts only)."
      : `Password for newly created accounts: ${password}\n(Set SEED_PASSWORD to choose your own. Existing accounts keep their password.)`,
  );
  await disconnectDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
