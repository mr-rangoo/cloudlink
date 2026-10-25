import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { createPackage } from "@/server/services/packages";
import { agentInput, createAgent, exportBatchCodes, generateBatch, listAgents, portalRedemptionStatus, recordRemittance, redeemFromPortal, redeemVoucher, voidBatch } from "@/server/services/vouchers";
import { runReconciliationChecks } from "@/server/services/finance";
import { trialBalance } from "@/server/services/ledger";
import { runOperation } from "@/server/jobs/operations";
import { operationHandlers } from "@/server/jobs/handlers";
import { contextFor, createOrg, createStaff } from "./fixtures";

const meta = (ip = "10.20.0.1") => ({ correlationId: "voucher-test-01", ipAddress: ip, userAgent: "vitest" });

async function setup(price = "50.00", taxRate = "16") {
  const org = await createOrg();
  const ctx = await contextFor(org.owner.id, org.organization.id);
  const pkg = await createPackage(ctx, { name: "Day Pass", serviceType: "HOTSPOT", price, taxRate, billingUnit: "DAY", billingCount: 1, downloadKbps: 5120, uploadKbps: 2048, description: null });
  return { org, ctx, pkg };
}

async function runAllOps() {
  for (const op of await db.backgroundOperation.findMany({ where: { status: { in: ["PENDING", "QUEUED"] } } })) await runOperation(op.id, operationHandlers);
}

describe("voucher batches", () => {
  it("returns codes once and stores only a keyed hash and an encrypted copy", async () => {
    const { ctx, pkg } = await setup();
    const { batch, codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 25, codeLength: 10 });
    expect(codes).toHaveLength(25);
    expect(new Set(codes).size).toBe(25);
    expect(codes.every((c) => /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/.test(c))).toBe(true);
    expect(batch.faceValue.toString()).toBe("58"); // 50 + 16% tax
    const stored = await db.voucher.findMany({ where: { batchId: batch.id } });
    const dump = JSON.stringify(stored);
    for (const c of codes) expect(dump).not.toContain(c);
    expect(stored.every((v) => /^[0-9a-f]{64}$/.test(v.codeHash) && v.codeEncrypted.startsWith("v1:"))).toBe(true);
  });

  it("restricts code exports to vouchers.export, returns only unused codes, and audits every export", async () => {
    const { org, ctx, pkg } = await setup();
    const { batch, codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 3, codeLength: 10 });
    await redeemVoucher(ctx, { code: codes[0]! }, "staff");
    const { user } = await createStaff(org.organization.id, "sales");
    const sales = await contextFor(user.id, org.organization.id);
    await expect(exportBatchCodes(sales, batch.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const exp = await exportBatchCodes(ctx, batch.id);
    expect(exp.codes.sort()).toEqual(codes.slice(1).sort());
    expect(await db.auditLog.count({ where: { action: "voucher_batch.export", entityId: batch.id } })).toBe(1);
  });
});

describe("redemption", () => {
  it("redeems once, posts the sale to the ledger, and grants the package duration", async () => {
    const { ctx, pkg } = await setup();
    const { codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 1, codeLength: 10 });
    const res = await redeemVoucher(ctx, { code: codes[0]!.toLowerCase().replace(/(.{4})/g, "$1-") }, "staff"); // case/hyphen-insensitive
    const hours = (res.accessEndsAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    await expect(redeemVoucher(ctx, { code: codes[0]! }, "staff")).rejects.toMatchObject({ code: "CONFLICT" });
    const tb = await trialBalance(ctx);
    const bal = (code: string) => tb.accounts.find((a) => a.code === code)!.balance;
    expect(bal("1150")).toBe("58.00");
    expect(bal("4000")).toBe("-50.00");
    expect(bal("2200")).toBe("-8.00");
  });

  it("allows exactly one of many concurrent redemptions of the same code", async () => {
    const { ctx, pkg } = await setup();
    const { codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 1, codeLength: 10 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => redeemVoucher(ctx, { code: codes[0]! }, "staff")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.voucherRedemption.count()).toBe(1);
    expect(await db.ledgerTransaction.count({ where: { type: "voucher.redeemed" } })).toBe(1);
  });

  it("rejects unknown, voided, expired and other-organization codes", async () => {
    const { ctx, pkg } = await setup();
    const other = await setup();
    const { codes: otherCodes } = await generateBatch(other.ctx, { packageId: other.pkg.id, quantity: 1, codeLength: 10 });
    await expect(redeemVoucher(ctx, { code: otherCodes[0]! }, "staff")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(redeemVoucher(ctx, { code: "ZZZZZZZZZZ" }, "staff")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(redeemVoucher(ctx, { code: "!!bad" }, "staff")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const v = await generateBatch(ctx, { packageId: pkg.id, quantity: 2, codeLength: 10 });
    await voidBatch(ctx, v.batch.id, "Printed with an error");
    await expect(redeemVoucher(ctx, { code: v.codes[0]! }, "staff")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const e = await generateBatch(ctx, { packageId: pkg.id, quantity: 1, codeLength: 10, expiresAt: new Date(Date.now() + 60_000) });
    await db.voucherBatch.update({ where: { id: e.batch.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(redeemVoucher(ctx, { code: e.codes[0]! }, "staff")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.voucher.findFirstOrThrow({ where: { batchId: e.batch.id } })).status).toBe("EXPIRED");
  });

  it("captive portal: rate-limited per IP, status requires the code, activation recorded honestly", async () => {
    const { org, ctx, pkg } = await setup();
    const { codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 1, codeLength: 10 });
    const res = await redeemFromPortal(org.organization.slug, { code: codes[0]!, mac: "AA:BB:CC:DD:EE:01" }, meta("10.20.0.2"));
    await expect(portalRedemptionStatus(org.organization.slug, res.redemptionId, "WRONGCODE2")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await portalRedemptionStatus(org.organization.slug, res.redemptionId, codes[0]!)).activationStatus).toBe("PENDING");
    await runAllOps();
    const s = await portalRedemptionStatus(org.organization.slug, res.redemptionId, codes[0]!);
    expect(s.activationStatus).toBe("SIMULATED");
    expect(s.activationDetail).toMatch(/No router was changed/);

    let limited = false;
    for (let i = 0; i < 12; i++) {
      try {
        await redeemFromPortal(org.organization.slug, { code: "ABCDEFGHJK" }, meta("10.20.0.3"));
      } catch (err) {
        if ((err as { code?: string }).code === "RATE_LIMITED") limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it("marks activation FAILED with the reason when network automation is unavailable", async () => {
    const { ctx, pkg } = await setup();
    const { codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 1, codeLength: 10 });
    const prev = process.env.NETWORK_ADAPTER;
    process.env.NETWORK_ADAPTER = "disabled";
    try {
      const r = await redeemVoucher(ctx, { code: codes[0]! }, "staff");
      await runAllOps();
      const row = await db.voucherRedemption.findUniqueOrThrow({ where: { id: r.redemptionId } });
      expect(row.activationStatus).toBe("FAILED");
      expect(row.activationDetail).toMatch(/disabled/);
    } finally {
      process.env.NETWORK_ADAPTER = prev;
    }
  });
});

describe("agents", () => {
  it("accrues commission on redemption, caps remittances at the amount owed, and reconciles with the ledger", async () => {
    const { ctx, pkg } = await setup("100.00", "0");
    const agent = await createAgent(ctx, agentInput.parse({ name: "Mama Njeri Shop", phone: "0712000999", commissionRate: "10" }));
    const { codes } = await generateBatch(ctx, { packageId: pkg.id, quantity: 5, codeLength: 10, agentId: agent.id });
    for (const c of codes.slice(0, 3)) await redeemVoucher(ctx, { code: c }, "staff");
    let a = (await listAgents(ctx)).agents.find((x) => x.id === agent.id)!;
    expect(a).toMatchObject({ redeemed: 3, sold: "300.00", commission: "30.00", owed: "270.00" });
    await expect(recordRemittance(ctx, agent.id, { amount: "300", method: "MPESA", receivedAt: new Date() })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await recordRemittance(ctx, agent.id, { amount: "200", method: "MPESA", reference: "SHOP1", receivedAt: new Date() });
    a = (await listAgents(ctx)).agents.find((x) => x.id === agent.id)!;
    expect(a.owed).toBe("70.00");
    const checks = await runReconciliationChecks(ctx);
    expect(checks.voucherReceivable).toEqual({ records: "70.00", ledger: "70.00", matches: true });
    expect(checks.ok).toBe(true);
    const tb = await trialBalance(ctx);
    expect(tb.accounts.find((x) => x.code === "5100")!.balance).toBe("30.00");
  });
});
