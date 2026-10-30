/**
 * Development helper: set one known password on the demo accounts so you can sign in.
 *
 *   npm run db:demo-password                 # uses Cloudlink-Demo-2026
 *   npm run db:demo-password -- "My-Pass-123"
 *
 * Touches only seed accounts (staff emails ending in ".demo") and, in organizations whose slug ends in "-demo",
 * the portal account of the first active subscriber (created if missing). Refuses to run in production.
 */
import "dotenv/config";

async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Refusing to change passwords in production.");
  const password = process.argv[2] ?? process.env.DEMO_PASSWORD ?? "Cloudlink-Demo-2026";
  const { db, disconnectDb } = await import("@/server/db/client");
  const { hashPassword, PASSWORD_MIN_LENGTH } = await import("@/server/security/crypto");
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  const passwordHash = await hashPassword(password);

  const staff = await db.user.findMany({ where: { email: { endsWith: ".demo" }, kind: "STAFF" }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, name: true } });
  for (const u of staff) await db.user.update({ where: { id: u.id }, data: { passwordHash, failedLogins: 0, lockedUntil: null, status: "ACTIVE" } });

  const customers: Array<{ org: string; name: string; phone: string; account: string }> = [];
  for (const org of await db.organization.findMany({ where: { slug: { endsWith: "-demo" } }, select: { id: true, slug: true } })) {
    const sub = await db.subscriber.findFirst({ where: { organizationId: org.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true, displayName: true, phone: true, accountNumber: true } });
    if (!sub) continue;
    const clash = await db.customerAccount.findFirst({ where: { organizationId: org.id, loginPhone: sub.phone, subscriberId: { not: sub.id } }, select: { id: true } });
    if (clash) continue;
    await db.customerAccount.upsert({
      where: { subscriberId: sub.id },
      update: { passwordHash, status: "ACTIVE", loginPhone: sub.phone, failedLogins: 0, lockedUntil: null, inviteTokenHash: null, inviteExpiresAt: null },
      create: { organizationId: org.id, subscriberId: sub.id, loginPhone: sub.phone, passwordHash, status: "ACTIVE", activatedAt: new Date() },
    });
    customers.push({ org: org.slug, name: sub.displayName, phone: sub.phone, account: sub.accountNumber });
  }

  console.log(`\nPassword for every account below: ${password}\n`);
  console.log("Staff (http://localhost:3100/login):");
  for (const u of staff) console.log(`  ${u.email.padEnd(28)} ${u.name}`);
  console.log("\nCustomer portal (http://localhost:3100/portal/<organization>/login, phone or account number):");
  for (const c of customers) console.log(`  /portal/${c.org}/login   ${c.phone}  or  ${c.account}   (${c.name})`);
  if (!staff.length) console.log("  No demo staff found. Run `npm run db:seed` first.");
  await disconnectDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
