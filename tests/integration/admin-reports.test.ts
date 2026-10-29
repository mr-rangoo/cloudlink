import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { db } from "@/server/db/client";
import { resetStorageForTests } from "@/server/integrations/storage";
import { createPackage } from "@/server/services/packages";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { createCreditNote, createManualInvoice, invoiceCreateInput } from "@/server/services/invoices";
import { manualPaymentInput, recordManualPayment, refundPayment } from "@/server/services/payments";
import { expenseInput, listExpenseCategories, recordExpense } from "@/server/services/finance";
import { trialBalance } from "@/server/services/ledger";
import { collectionsReport, receivablesAging, resolveMonthRange, revenueReport, subscriberReport } from "@/server/services/reports";
import { downloadExport, requestExport } from "@/server/services/exports";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { completeStaffInvite, createBranch, createStaffResetLink, deleteRole, getSettings, inviteStaff, listRoles, roleInput, listStaff, searchAuditLogs, updateBranch, updateRole, updateSettings, updateStaff } from "@/server/services/admin";
import { applyItemAction, createItem, getItem, itemInput } from "@/server/services/inventory";
import { integrationStatus } from "@/server/services/integrations";
import { loginStaff } from "@/server/auth/service";
import { resolveSession } from "@/server/auth/session";
import { contextFor, createOrg, createStaff, sessionFor } from "./fixtures";

const meta = { correlationId: "admin-test-001", ipAddress: "10.7.0.1", userAgent: "vitest" };
let seq = 0;
const tel = () => `07${String(30_000_000 + seq++).padStart(8, "0")}`;

beforeAll(() => {
  resetStorageForTests(mkdtempSync(path.join(os.tmpdir(), "cloudlink-test-exports-")));
});

async function setup() {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  return { org, ctx };
}

async function runAllOps() {
  for (const op of await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED"] } } })) await runOperation(op.id, operationHandlers);
}

describe("reports agree with the ledger", () => {
  it("revenue, collections and aging reconcile with the trial balance", async () => {
    const { ctx } = await setup();
    const pkg = await createPackage(ctx, { name: "Plan P", serviceType: "PPPOE", price: "2000.00", taxRate: "16", billingUnit: "MONTH", billingCount: 1, description: null });
    const { subscriber: a } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Ann", phone: tel(), packageId: pkg.id })); // 2320 invoice
    const { subscriber: b } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Ben", phone: tel() }));
    const inv = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: b.id, lines: [{ description: "Router", quantity: "1", unitPrice: "5000" }] }));
    await createCreditNote(ctx, inv.id, { amount: "500", reason: "Promo" });
    const { payment } = await recordManualPayment(ctx, manualPaymentInput.parse({ subscriberId: a.id, amount: "3000", method: "MPESA", reference: "QWE123", receivedAt: new Date(Date.now() - 1000).toISOString() }));
    await refundPayment(ctx, payment.id, { amount: "680", method: "MPESA", reason: "Overpayment" });
    const [cat] = await listExpenseCategories(ctx);
    await recordExpense(ctx, expenseInput.parse({ categoryId: cat!.id, amount: "1200", method: "CASH", paidAt: new Date(Date.now() - 1000).toISOString(), description: "Fuel" }));

    const rev = await revenueReport(ctx, {});
    const tb = await trialBalance(ctx);
    const bal = (code: string) => Number(tb.accounts.find((x) => x.code === code)!.balance);
    expect(rev.totals.revenue).toBe((-bal("4000")).toFixed(2)); // 2000 + 5000
    expect(rev.totals.revenue).toBe("7000.00");
    expect(rev.totals.creditNotes).toBe(bal("4100").toFixed(2)); // 500
    expect(rev.totals.netRevenue).toBe("6500.00");
    expect(rev.totals.tax).toBe("320.00");
    expect(rev.totals.collected).toBe("2320.00"); // 3000 received − 680 refunded
    expect(rev.totals.expenses).toBe("1200.00");

    const aging = await receivablesAging(ctx);
    expect(aging.totals.total).toBe(bal("1100").toFixed(2)); // equals AR in the ledger
    expect(aging.totals.total).toBe("4500.00"); // Ben 5000 − 500 credit; Ann paid in full

    const subsReport = await subscriberReport(ctx, {});
    expect(subsReport.months.at(-1)!.newSubscribers).toBe(2);
    expect(subsReport.byPackage).toEqual([expect.objectContaining({ packageName: "Plan P", active: 1, mrr: "2000.00" })]);

    const col = await collectionsReport(ctx, {});
    expect(col.months.at(-1)!.total).toBe("3000.00");
  });

  it("buckets receivables by days past due", async () => {
    const { ctx } = await setup();
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Old", phone: tel() }));
    for (const daysAgo of [-5, 10, 45, 75, 120]) {
      const inv = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, lines: [{ description: `d${daysAgo}`, quantity: "1", unitPrice: "100" }] }));
      await db.$executeRaw`UPDATE "Invoice" SET "dueAt" = now() - make_interval(days => ${daysAgo}) WHERE "id" = ${inv.id}::uuid`;
    }
    const aging = await receivablesAging(ctx);
    expect(aging.totals).toMatchObject({ current: "100.00", "1-30": "100.00", "31-60": "100.00", "61-90": "100.00", "90+": "100.00", total: "500.00" });
  });

  it("resolves month ranges in the organization timezone", () => {
    const r = resolveMonthRange("Africa/Nairobi", "2026-01", "2026-03");
    expect(r.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(r.start.toISOString()).toBe("2025-12-31T21:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-03-31T21:00:00.000Z");
  });
});

describe("exports", () => {
  it("generates a CSV in the worker, neutralises formulas, audits the download and isolates organizations", async () => {
    const { ctx } = await setup();
    const other = await setup();
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "=HYPERLINK(\"http://x\")", phone: tel() }));
    const job = await requestExport(ctx, { type: "subscribers", params: {} });
    expect(job.status).toBe("QUEUED");
    await runAllOps();
    const ready = await db.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(ready.status).toBe("READY");
    expect(ready.rowCount).toBe(1);
    const { data } = await downloadExport(ctx, job.id);
    const text = data.toString("utf8");
    expect(text).toContain("account_number,name");
    expect(text).toContain("'=HYPERLINK");
    expect(await db.auditLog.count({ where: { action: "export.download", entityId: job.id } })).toBe(1);
    await expect(downloadExport(other.ctx, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.exportJob.update({ where: { id: job.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(downloadExport(ctx, job.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("EXPIRED");
  });

  it("requires the export permission plus read access to the data", async () => {
    const { org, ctx } = await setup();
    const { user } = await createStaff(org.organization.id, "support");
    const support = await contextFor(user.id, org.organization.id);
    await expect(requestExport(support, { type: "subscribers", params: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { user: acc } = await createStaff(org.organization.id, "accountant");
    const accountant = await contextFor(acc.id, org.organization.id);
    await expect(requestExport(accountant, { type: "invoices", params: {} })).resolves.toBeTruthy();
    void ctx;
  });

  it("fails the job if the requester lost access before generation", async () => {
    const { org, ctx } = await setup();
    const { user, membership } = await createStaff(org.organization.id, "accountant");
    const acc = await contextFor(user.id, org.organization.id);
    const job = await requestExport(acc, { type: "payments", params: {} });
    await updateStaff(ctx, membership.id, { status: "INACTIVE" });
    await runAllOps();
    expect((await db.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");
  });
});

describe("staff and roles", () => {
  it("invites a new staff member with a single-use setup link", async () => {
    const { org, ctx } = await setup();
    const roles = await listRoles(ctx);
    const cashierRole = roles.roles.find((r) => r.key === "cashier")!;
    const res = await inviteStaff(ctx, { name: "New Cashier", email: "New.Cashier@Example.test", roleIds: [cashierRole.id], branchIds: [org.branch.id] });
    expect(res.setupLink).toMatch(/\/invite\//);
    const token = decodeURIComponent(res.setupLink!.split("/invite/")[1]!);
    await expect(loginStaff({ email: "new.cashier@example.test", password: "Some-Password-1" }, meta)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await completeStaffInvite({ token, password: "Cashier-Pass-123" }, meta);
    await expect(completeStaffInvite({ token, password: "Another-Pass-123" }, meta)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const session = await loginStaff({ email: "new.cashier@example.test", password: "Cashier-Pass-123" }, meta);
    expect(session.token).toBeTruthy();
    const staff = await listStaff(ctx);
    expect(staff.find((s) => s.email === "new.cashier@example.test")).toMatchObject({ allBranches: false, branchIds: [org.branch.id], pendingSetup: false });
  });

  it("protects owners, prevents self-lockout and revokes sessions on permission changes", async () => {
    const { org, ctx } = await setup();
    const me = (await listStaff(ctx)).find((s) => s.userId === org.owner.id)!;
    const roles = await listRoles(ctx);
    const support = roles.roles.find((r) => r.key === "support")!;
    await expect(updateStaff(ctx, me.membershipId, { status: "INACTIVE" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    // An admin cannot grant the owner role or modify an owner.
    const { user: adminUser } = await createStaff(org.organization.id, "admin");
    const admin = await contextFor(adminUser.id, org.organization.id);
    const ownerRole = roles.roles.find((r) => r.key === "owner")!;
    await expect(inviteStaff(admin, { name: "X", email: "x@example.test", roleIds: [ownerRole.id], branchIds: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateStaff(admin, me.membershipId, { roleIds: [support.id] })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Changing a member's roles revokes their sessions.
    const { user, membership } = await createStaff(org.organization.id, "accountant");
    const token = await sessionFor(user.id, org.organization.id);
    await updateStaff(ctx, membership.id, { roleIds: [support.id] });
    expect(await resolveSession(token)).toBeNull();
    expect((await contextFor(user.id, org.organization.id)).roles).toEqual(["support"]);

    // The last owner cannot be removed (only one owner exists).
    const second = await setup();
    const otherOwner = (await listStaff(second.ctx)).find((s) => s.roles.some((r) => r.key === "owner"))!;
    const { user: o2 } = await createStaff(second.org.organization.id, "owner");
    const owner2 = await contextFor(o2.id, second.org.organization.id);
    await updateStaff(owner2, otherOwner.membershipId, { status: "INACTIVE" }); // allowed: owner2 remains
    const owner2Membership = (await listStaff(owner2)).find((s) => s.userId === o2.id)!;
    await expect(updateStaff(second.ctx, owner2Membership.membershipId, { status: "INACTIVE" })).rejects.toThrow(); // second.ctx owner is now inactive
  });

  it("issues single-use reset links that revoke existing sessions", async () => {
    const { org, ctx } = await setup();
    const { user, membership } = await createStaff(org.organization.id, "support");
    const old = await sessionFor(user.id, org.organization.id);
    const { link } = await createStaffResetLink(ctx, membership.id);
    await completeStaffInvite({ token: decodeURIComponent(link.split("/invite/")[1]!), password: "Brand-New-Pass-1" }, meta);
    expect(await resolveSession(old)).toBeNull();
    await expect(loginStaff({ email: user.email, password: "Brand-New-Pass-1" }, meta)).resolves.toBeTruthy();
  });

  it("edits role permissions with immediate effect; the owner role and built-in roles are protected", async () => {
    const { org, ctx } = await setup();
    const { roles } = await listRoles(ctx);
    const support = roles.find((r) => r.key === "support")!;
    const { user } = await createStaff(org.organization.id, "support");
    expect((await contextFor(user.id, org.organization.id)).permissions.has("invoices.write")).toBe(false);
    const res = await updateRole(ctx, support.id, roleInput.parse({ name: support.name, description: support.description, permissions: [...support.permissions, "invoices.write"] }));
    expect(res.added).toEqual(["invoices.write"]);
    expect((await contextFor(user.id, org.organization.id)).permissions.has("invoices.write")).toBe(true);
    const owner = roles.find((r) => r.key === "owner")!;
    await expect(updateRole(ctx, owner.id, { name: "Owner", permissions: [] })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(deleteRole(ctx, support.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateRole(ctx, support.id, { name: "x", permissions: ["not.a.permission"] } as never)).rejects.toThrow();
  });
});

describe("branches, settings and audit", () => {
  it("creates branches and refuses to archive one with subscribers", async () => {
    const { ctx } = await setup();
    const b = await createBranch(ctx, { name: "Thika", code: "thk", address: null });
    expect(b.code).toBe("THK");
    await createSubscriber(ctx, subscriberInput.parse({ firstName: "T", phone: tel(), branchId: b.id }));
    await expect(updateBranch(ctx, b.id, { status: "ARCHIVED" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(createBranch(ctx, { name: "Dup", code: "THK", address: null })).rejects.toBeTruthy();
  });

  it("applies billing settings to new documents and records the change", async () => {
    const { ctx } = await setup();
    await updateSettings(ctx, { name: "Renamed ISP", billing: { invoicePrefix: "SKY", paymentTermsDays: 7, taxPin: "P051234567X" } });
    const s = await getSettings(ctx);
    expect(s.organization.name).toBe("Renamed ISP");
    expect(s.billing).toMatchObject({ invoicePrefix: "SKY", paymentTermsDays: 7 });
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "S", phone: tel() }));
    const inv = await createManualInvoice(ctx, invoiceCreateInput.parse({ subscriberId: subscriber.id, lines: [{ description: "x", quantity: "1", unitPrice: "10" }] }));
    expect(inv.invoiceNumber).toMatch(/^SKY-\d{6}$/);
    const days = (inv.dueAt!.getTime() - inv.issuedAt!.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8.1);
    const log = await searchAuditLogs(ctx, { action: "settings.", page: 1, pageSize: 10 });
    expect(log.total).toBe(1);
    expect(log.rows[0]!.actor?.id).toBe(ctx.userId);
  });

  it("filters the audit log and keeps tenants apart", async () => {
    const a = await setup();
    const b = await setup();
    await createBranch(a.ctx, { name: "A2", code: "AA2", address: null });
    expect((await searchAuditLogs(a.ctx, { entityType: "branch", page: 1, pageSize: 10 })).total).toBe(1);
    expect((await searchAuditLogs(b.ctx, { entityType: "branch", page: 1, pageSize: 10 })).total).toBe(0);
  });
});

describe("inventory", () => {
  it("tracks equipment through valid transitions with a movement history", async () => {
    const { ctx } = await setup();
    const { subscriber } = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Eq", phone: tel() }));
    const item = await createItem(ctx, itemInput.parse({ category: "onu", model: "Huawei HG8145V5", serialNumber: "48575443abcd1234", macAddress: "aa:bb:cc:dd:ee:ff" }));
    expect(item.serialNumber).toBe("48575443ABCD1234");
    await expect(createItem(ctx, itemInput.parse({ category: "onu", model: "dup", serialNumber: "48575443ABCD1234" }))).rejects.toBeTruthy();
    await expect(applyItemAction(ctx, item.id, { action: "assign" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await applyItemAction(ctx, item.id, { action: "assign", subscriberId: subscriber.id });
    await expect(applyItemAction(ctx, item.id, { action: "retire" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await applyItemAction(ctx, item.id, { action: "mark_faulty", note: "No PON light" });
    await applyItemAction(ctx, item.id, { action: "repaired" });
    await applyItemAction(ctx, item.id, { action: "retire" });
    const full = await getItem(ctx, item.id);
    expect(full.status).toBe("RETIRED");
    expect(full.subscriberId).toBeNull();
    expect(full.movements.map((m) => m.action).reverse()).toEqual(["received", "assigned", "marked_faulty", "repaired", "retired"]);
    await expect(db.inventoryItem.update({ where: { id: item.id }, data: { status: "ASSIGNED" } })).rejects.toThrow(); // DB check: assigned needs a subscriber
  });
});

describe("integration status", () => {
  it("reports mock and unconfigured integrations honestly and never returns secrets", async () => {
    const { ctx } = await setup();
    const rows = await integrationStatus(ctx);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.mpesa_daraja!.status).toBe("mock");
    expect(by.radius!.status).toBe("not_configured");
    expect(by.manual_payments!.status).toBe("ok");
    expect(JSON.stringify(rows)).not.toMatch(/secret|passkey|password/i);
  });
});
