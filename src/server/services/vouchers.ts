import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, resolveBranchForCreate, systemContext, type ActorContext, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { D, percentInput, positiveMoneyInput } from "@/server/domain/money";
import { periodBoundary } from "@/server/domain/billing-period";
import { generateCode, hashCode, isPlausibleCode, normalizeCode } from "@/server/domain/vouchers";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { normalizePhone } from "@/server/domain/contact";
import { actorUserId, nextCounter } from "@/server/services/common";
import { cashAccountFor, postLedger } from "@/server/services/ledger";
import { defaultHotspotRouterId, dispatchNetworkOperations, requestNetworkOperationTx } from "@/server/services/network";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { Prisma } from "@/generated/prisma/client";

const dec = (v: { toString(): string }) => new D(v.toString());
const METHODS = ["CASH", "BANK_TRANSFER", "MPESA", "CHEQUE", "CARD", "OTHER"] as const;

// ───────── Agents ─────────

export const agentInput = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .transform((v, c) => {
      const n = normalizePhone(v);
      if (!n) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
      return n ?? "";
    }),
  commissionRate: percentInput.default("0"),
  branchId: z.uuid().optional().nullable(),
});
export const agentUpdateInput = z.object({ name: z.string().trim().min(2).max(120).optional(), commissionRate: percentInput.optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() });
export const remittanceInput = z.object({ amount: positiveMoneyInput, method: z.enum(METHODS), reference: z.string().trim().max(100).optional().nullable(), receivedAt: z.coerce.date() });

/**
 * Agent balance (what the agent owes) from source records:
 * Σ face value of redeemed agent vouchers − Σ commissions − Σ remittances.
 * The ledger's Voucher receivable account (1150) equals the sum over all agents (reconciliation check).
 */
export async function agentBalances(organizationId: string, agentIds?: string[]) {
  const where = { organizationId, ...(agentIds ? { agentId: { in: agentIds } } : {}) };
  const [sales, commissions, remittances] = await Promise.all([
    db.voucherRedemption.groupBy({ by: ["agentId"], where, _sum: { faceValue: true }, _count: { _all: true } }),
    db.agentCommission.groupBy({ by: ["agentId"], where, _sum: { amount: true } }),
    db.agentRemittance.groupBy({ by: ["agentId"], where, _sum: { amount: true } }),
  ]);
  const ids = new Set([...sales, ...commissions, ...remittances].map((r) => r.agentId ?? "direct"));
  const out = new Map<string, { sold: string; redeemed: number; commission: string; remitted: string; owed: string }>();
  for (const id of ids) {
    const s = sales.find((r) => (r.agentId ?? "direct") === id);
    const c = commissions.find((r) => r.agentId === id);
    const r = remittances.find((x) => x.agentId === id);
    const sold = dec(s?._sum.faceValue ?? 0);
    const commission = dec(c?._sum.amount ?? 0);
    const remitted = dec(r?._sum.amount ?? 0);
    out.set(id, { sold: sold.toFixed(2), redeemed: s?._count._all ?? 0, commission: commission.toFixed(2), remitted: remitted.toFixed(2), owed: sold.minus(commission).minus(remitted).toFixed(2) });
  }
  return out;
}

export async function listAgents(ctx: StaffContext) {
  requirePermission(ctx, "vouchers.read");
  const agents = await db.agent.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ status: "asc" }, { name: "asc" }] });
  const balances = await agentBalances(ctx.organizationId);
  const zero = { sold: "0.00", redeemed: 0, commission: "0.00", remitted: "0.00", owed: "0.00" };
  return { agents: agents.map((a) => ({ ...a, ...(balances.get(a.id) ?? zero) })), direct: balances.get("direct") ?? zero };
}

export async function createAgent(ctx: StaffContext, input: z.infer<typeof agentInput>) {
  requirePermission(ctx, "vouchers.write");
  const branchId = input.branchId ? await resolveBranchForCreate(ctx, input.branchId) : null;
  const a = await db.agent.create({ data: { organizationId: ctx.organizationId, name: input.name, phone: input.phone, commissionRate: input.commissionRate, branchId } });
  await audit(ctx, { action: "agent.create", entityType: "agent", entityId: a.id, metadata: { commissionRate: input.commissionRate } });
  return a;
}

export async function updateAgent(ctx: StaffContext, id: string, input: z.infer<typeof agentUpdateInput>) {
  requirePermission(ctx, "vouchers.write");
  const a = await db.agent.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!a) throw notFound("agent");
  const updated = await db.agent.update({ where: { id }, data: input });
  await audit(ctx, { action: "agent.update", entityType: "agent", entityId: id, metadata: { ...input, previousRate: a.commissionRate.toString() } });
  return updated;
}

/** Cash handed over by an agent for vouchers sold. Cannot exceed what the agent owes. */
export async function recordRemittance(ctx: StaffContext, agentId: string, input: z.infer<typeof remittanceInput>) {
  requirePermission(ctx, "payments.record");
  const agent = await db.agent.findFirst({ where: { id: agentId, organizationId: ctx.organizationId } });
  if (!agent) throw notFound("agent");
  const r = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId}::uuid FOR UPDATE`;
    const owed = new D((await agentBalances(ctx.organizationId, [agentId])).get(agentId)?.owed ?? "0");
    if (new D(input.amount).gt(owed)) throw new AppError("INVALID_STATE", `${agent.name} owes ${owed.toFixed(2)}; record at most that amount.`);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
    const rem = await tx.agentRemittance.create({ data: { organizationId: ctx.organizationId, agentId, amount: input.amount, method: input.method, reference: input.reference ?? null, receivedAt: input.receivedAt, recordedById: ctx.userId } });
    await postLedger(tx, ctx, {
      type: "agent.remittance",
      sourceType: "agent_remittance",
      sourceId: rem.id,
      description: `Remittance from ${agent.name}`,
      currency: org.currency,
      occurredAt: input.receivedAt,
      lines: [
        { account: cashAccountFor(input.method), debit: new D(input.amount) },
        { account: "VOUCHER_RECEIVABLE", credit: new D(input.amount) },
      ],
    });
    return rem;
  });
  await audit(ctx, { action: "agent.remittance", entityType: "agent", entityId: agentId, metadata: { amount: input.amount, method: input.method } });
  return r;
}

// ───────── Batches ─────────

export const batchInput = z.object({
  packageId: z.uuid(),
  quantity: z.coerce.number().int().min(1).max(1000),
  codeLength: z.coerce.number().int().min(8).max(16).default(10),
  agentId: z.uuid().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
  branchId: z.uuid().optional().nullable(),
  /** Hotspot router for these vouchers; defaults to the organization's only hotspot-enabled router. */
  routerId: z.uuid().optional().nullable(),
});

/** Generate a batch. Plaintext codes are returned once; only a keyed hash and an encrypted copy are stored. */
export async function generateBatch(ctx: StaffContext, input: z.infer<typeof batchInput>) {
  requirePermission(ctx, "vouchers.write");
  const pkg = await db.package.findFirst({ where: { id: input.packageId, organizationId: ctx.organizationId } });
  if (!pkg) throw notFound("package");
  if (pkg.status !== "ACTIVE") throw new AppError("INVALID_STATE", "Choose an active package.");
  if (input.agentId && !(await db.agent.findFirst({ where: { id: input.agentId, organizationId: ctx.organizationId, status: "ACTIVE" } }))) throw notFound("agent");
  if (input.expiresAt && input.expiresAt < new Date()) throw new AppError("VALIDATION_ERROR", "The expiry date must be in the future.", { fields: [{ path: "expiresAt", message: "Past date" }] });
  const branchId = input.branchId ? await resolveBranchForCreate(ctx, input.branchId) : null;
  if (input.routerId && !(await db.router.findFirst({ where: { id: input.routerId, organizationId: ctx.organizationId, hotspotEnabled: true, archivedAt: null } }))) {
    throw new AppError("VALIDATION_ERROR", "Choose a hotspot-enabled router.", { fields: [{ path: "routerId", message: "Not a hotspot router" }] });
  }
  const net = dec(pkg.price);
  const face = net.plus(net.mul(dec(pkg.taxRate)).div(100)).toDecimalPlaces(2);

  const codes = new Set<string>();
  while (codes.size < input.quantity) codes.add(generateCode(input.codeLength));
  const list = [...codes];

  const batch = await db.$transaction(
    async (tx) => {
      const seq = await nextCounter(tx, ctx.organizationId, "voucher_batch");
      const b = await tx.voucherBatch.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          batchNumber: `VB-${String(seq).padStart(5, "0")}`,
          packageId: pkg.id,
          packageName: pkg.name,
          durationUnit: pkg.billingUnit,
          durationCount: pkg.billingCount,
          downloadKbps: pkg.downloadKbps,
          uploadKbps: pkg.uploadKbps,
          netPrice: net.toFixed(2),
          taxRate: pkg.taxRate,
          faceValue: face.toFixed(2),
          currency: pkg.currency,
          quantity: input.quantity,
          agentId: input.agentId ?? null,
          routerId: input.routerId ?? null,
          expiresAt: input.expiresAt ?? null,
          notes: input.notes ?? null,
          createdById: ctx.userId,
        },
      });
      await tx.voucher.createMany({
        data: list.map((code) => ({ organizationId: ctx.organizationId, batchId: b.id, codeHash: hashCode(ctx.organizationId, code), codeEncrypted: encryptSecret(code, `voucher:${ctx.organizationId}`), codeHint: code.slice(-3) })),
      });
      return b;
    },
    { timeout: 60_000 },
  );
  await audit(ctx, { action: "voucher_batch.create", entityType: "voucher_batch", entityId: batch.id, metadata: { quantity: input.quantity, packageId: pkg.id, agentId: input.agentId ?? null } });
  return { batch, codes: list };
}

export async function listBatches(ctx: StaffContext) {
  requirePermission(ctx, "vouchers.read");
  const batches = await db.voucherBatch.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 200 });
  const counts = await db.voucher.groupBy({ by: ["batchId", "status"], where: { organizationId: ctx.organizationId, batchId: { in: batches.map((b) => b.id) } }, _count: { _all: true } });
  const agents = new Map((await db.agent.findMany({ where: { organizationId: ctx.organizationId } })).map((a) => [a.id, a.name]));
  const now = new Date();
  return batches.map((b) => {
    const c = (s: string) => counts.find((x) => x.batchId === b.id && x.status === s)?._count._all ?? 0;
    return { ...b, agentName: b.agentId ? (agents.get(b.agentId) ?? null) : null, unused: c("UNUSED"), redeemed: c("REDEEMED"), voided: c("VOID"), expired: b.expiresAt !== null && b.expiresAt < now };
  });
}

export async function getBatch(ctx: StaffContext, id: string) {
  requirePermission(ctx, "vouchers.read");
  const b = await db.voucherBatch.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!b) throw notFound("voucher batch");
  const vouchers = await db.voucher.findMany({ where: { batchId: id }, orderBy: { createdAt: "asc" }, select: { id: true, codeHint: true, status: true, redeemedAt: true, redemption: { select: { channel: true, clientMac: true, activationStatus: true, accessEndsAt: true } } } });
  const agent = b.agentId ? await db.agent.findUnique({ where: { id: b.agentId }, select: { id: true, name: true } }) : null;
  return { ...b, agent, vouchers };
}

export async function voidBatch(ctx: StaffContext, id: string, reason: string) {
  requirePermission(ctx, "vouchers.write");
  const b = await db.voucherBatch.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!b) throw notFound("voucher batch");
  if (b.status === "VOID") throw new AppError("CONFLICT", "This batch is already void.");
  const res = await db.$transaction(async (tx) => {
    const r = await tx.voucher.updateMany({ where: { batchId: id, status: "UNUSED" }, data: { status: "VOID", voidedAt: new Date() } });
    await tx.voucherBatch.update({ where: { id }, data: { status: "VOID" } });
    return r.count;
  });
  await audit(ctx, { action: "voucher_batch.void", entityType: "voucher_batch", entityId: id, metadata: { reason, voided: res } });
  return { voided: res };
}

/** Controlled export of unused codes (decrypted). Requires vouchers.export; every export is audited and counted. */
export async function exportBatchCodes(ctx: StaffContext, id: string) {
  requirePermission(ctx, "vouchers.export");
  const b = await db.voucherBatch.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!b) throw notFound("voucher batch");
  if (b.status === "VOID") throw new AppError("INVALID_STATE", "Void batches cannot be exported.");
  const rows = await db.voucher.findMany({ where: { batchId: id, status: "UNUSED" }, orderBy: { createdAt: "asc" }, select: { codeEncrypted: true } });
  await db.voucherBatch.update({ where: { id }, data: { exportCount: { increment: 1 } } });
  await audit(ctx, { action: "voucher_batch.export", entityType: "voucher_batch", entityId: id, metadata: { codes: rows.length, exportNumber: b.exportCount + 1 } });
  return { batch: b, codes: rows.map((r) => decryptSecret(r.codeEncrypted, `voucher:${ctx.organizationId}`)) };
}

// ───────── Redemption ─────────

export const redeemInput = z.object({
  code: z.string().trim().min(6).max(40),
  mac: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  ip: z.ipv4().optional().nullable().or(z.literal("").transform(() => null)),
});

const invalidVoucher = () => new AppError("VALIDATION_ERROR", "This voucher code is not valid. Check the code and try again.");

/**
 * Atomically redeem a voucher (row lock + unique redemption): exactly one concurrent attempt can succeed.
 * Posts the sale to the ledger, accrues agent commission, and queues hotspot activation. Activation is a separate,
 * honestly-reported status (mock adapters report SIMULATED; nothing claims a real router change).
 */
export async function redeemVoucher(ctx: ActorContext, input: z.infer<typeof redeemInput>, channel: "captive_portal" | "staff") {
  const code = normalizeCode(input.code);
  if (!isPlausibleCode(code)) throw invalidVoucher();
  const codeHash = hashCode(ctx.organizationId, code);
  const now = new Date();
  const tz = (await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })).timezone;

  const result = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Voucher" WHERE "organizationId" = ${ctx.organizationId}::uuid AND "codeHash" = ${codeHash} FOR UPDATE`;
    if (!rows.length) throw invalidVoucher();
    const v = await tx.voucher.findUniqueOrThrow({ where: { id: rows[0]!.id }, include: { batch: true } });
    if (v.status === "REDEEMED") throw new AppError("CONFLICT", "This voucher has already been used.");
    if (v.status !== "UNUSED" || v.batch.status !== "ACTIVE") throw invalidVoucher();
    if (v.batch.expiresAt && v.batch.expiresAt < now) {
      await tx.voucher.update({ where: { id: v.id }, data: { status: "EXPIRED" } });
      return { expired: true as const };
    }
    const accessEndsAt = periodBoundary(now, v.batch.durationUnit, v.batch.durationCount, 1, tz);
    await tx.voucher.update({ where: { id: v.id }, data: { status: "REDEEMED", redeemedAt: now } });
    const redemption = await tx.voucherRedemption.create({
      data: {
        organizationId: ctx.organizationId,
        voucherId: v.id,
        batchId: v.batchId,
        agentId: v.batch.agentId,
        channel,
        clientMac: input.mac ?? null,
        clientIp: input.ip ?? null,
        redeemedByUserId: actorUserId(ctx),
        faceValue: v.batch.faceValue,
        accessEndsAt,
      },
    });
    const face = dec(v.batch.faceValue);
    const net = dec(v.batch.netPrice);
    await postLedger(tx, ctx, {
      type: "voucher.redeemed",
      sourceType: "voucher_redemption",
      sourceId: redemption.id,
      description: `Voucher …${v.codeHint} redeemed (${v.batch.packageName})`,
      currency: v.batch.currency,
      lines: [
        { account: "VOUCHER_RECEIVABLE", debit: face },
        { account: "REVENUE", credit: net },
        { account: "TAX_PAYABLE", credit: face.minus(net) },
      ],
    });
    if (v.batch.agentId) {
      const agent = await tx.agent.findUnique({ where: { id: v.batch.agentId } });
      const commission = face.mul(dec(agent?.commissionRate ?? 0)).div(100).toDecimalPlaces(2);
      if (agent && commission.gt(0)) {
        const c = await tx.agentCommission.create({ data: { organizationId: ctx.organizationId, agentId: agent.id, redemptionId: redemption.id, amount: commission.toFixed(2) } });
        await postLedger(tx, ctx, {
          type: "agent.commission",
          sourceType: "agent_commission",
          sourceId: c.id,
          description: `Commission to ${agent.name} on voucher …${v.codeHint}`,
          currency: v.batch.currency,
          lines: [
            { account: "AGENT_COMMISSIONS", debit: commission },
            { account: "VOUCHER_RECEIVABLE", credit: commission },
          ],
        });
      }
    }
    // Activation is a durable network operation; its real outcome is written back to the redemption.
    const op = await requestNetworkOperationTx(tx, ctx, {
      type: "hotspot.user.upsert",
      routerId: v.batch.routerId ?? (await defaultHotspotRouterId(tx, ctx.organizationId)),
      redemptionId: redemption.id,
      params: { batchId: v.batchId },
      idempotencyKey: `hotspot:${redemption.id}`,
    });
    return { expired: false as const, redemption, op, batch: v.batch };
  });
  if (result.expired) throw new AppError("INVALID_STATE", "This voucher has expired.");
  await dispatchNetworkOperations(ctx.organizationId, { ids: [result.op.id] });
  await audit(ctx, {
    action: "voucher.redeem",
    entityType: "voucher_redemption",
    entityId: result.redemption.id,
    metadata: { channel, batchId: result.batch.id, mac: input.mac ?? null },
  });
  return { redemptionId: result.redemption.id, packageName: result.batch.packageName, accessEndsAt: result.redemption.accessEndsAt, activationStatus: result.redemption.activationStatus };
}

/** Public captive-portal redemption: organization by slug, rate-limited per IP and per organization. */
export async function redeemFromPortal(orgSlug: string, input: z.infer<typeof redeemInput>, meta: { ipAddress: string | null; userAgent: string | null; correlationId: string }) {
  await consumeRateLimit(RATE_LIMITS.voucherRedeem, `ip:${meta.ipAddress ?? "unknown"}`);
  const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true, status: true } });
  if (!org || org.status !== "ACTIVE") throw new AppError("NOT_FOUND", "Unknown hotspot.");
  await consumeRateLimit({ name: "voucher:org", limit: 600, windowSeconds: 60 }, org.id);
  const ctx = systemContext(org.id, "hotspot:portal", meta.correlationId);
  return redeemVoucher({ ...ctx, ipAddress: meta.ipAddress, userAgent: meta.userAgent }, { ...input, ip: input.ip ?? meta.ipAddress }, "captive_portal");
}

/** Status poll for the captive portal; requires the voucher code as proof of possession. */
export async function portalRedemptionStatus(orgSlug: string, redemptionId: string, code: string) {
  const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
  if (!org) throw notFound("redemption");
  const r = await db.voucherRedemption.findFirst({ where: { id: redemptionId, organizationId: org.id }, include: { voucher: { select: { codeHash: true } } } });
  if (!r || r.voucher.codeHash !== hashCode(org.id, code)) throw notFound("redemption");
  return { activationStatus: r.activationStatus, activationDetail: r.activationDetail, accessEndsAt: r.accessEndsAt };
}

export async function redemptionStats(ctx: StaffContext) {
  requirePermission(ctx, "vouchers.read");
  const where: Prisma.VoucherRedemptionWhereInput = { organizationId: ctx.organizationId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } };
  const [count, sum, byStatus] = await Promise.all([
    db.voucherRedemption.count({ where }),
    db.voucherRedemption.aggregate({ where, _sum: { faceValue: true } }),
    db.voucherRedemption.groupBy({ by: ["activationStatus"], where, _count: { _all: true } }),
  ]);
  return { last30Days: { redemptions: count, value: dec(sum._sum.faceValue ?? 0).toFixed(2) }, activation: Object.fromEntries(byStatus.map((b) => [b.activationStatus, b._count._all])) };
}

