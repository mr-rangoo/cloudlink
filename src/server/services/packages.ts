import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Tx } from "@/server/db/client";
import { hasPermission, requirePermission, type ActorContext, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound, type FieldIssue } from "@/server/errors";
import { D, moneyInput, percentInput } from "@/server/domain/money";
import { branchFilterSql, searchTerm } from "@/server/services/common";
import { dispatchNetworkOperations, requestNetworkOperationTx } from "@/server/services/network";
import { availabilityOf, burstProblem, defaultProfileName, hasBurst, planTypeOf, routerRateLimit, type Availability, type PlanType } from "@/lib/plans";
import { Prisma, type Package } from "@/generated/prisma/client";

/**
 * Plans (packages). A plan's commercial terms are snapshotted onto each subscription, so edits apply to new sales
 * only. Its network settings (speed, burst, devices) live in a router profile that Cloudlink creates or updates on
 * every router the plan may be used on, through durable, read-back-verified network operations.
 */

const BILLING_UNITS = ["MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;
const KINDS = ["TIME", "DATA", "TRIAL", "DEVICE"] as const;
const SERVICE_TYPES = ["PPPOE", "HOTSPOT", "STATIC_IP", "OTHER"] as const;
export const MAX_DURATION_COUNT: Record<(typeof BILLING_UNITS)[number], number> = { MINUTE: 1440, HOUR: 720, DAY: 365, WEEK: 104, MONTH: 60, YEAR: 10 };

const optionalInt = (min: number, max: number) => z.union([z.coerce.number().int().min(min).max(max), z.literal("").transform(() => null), z.null()]).optional();
const optionalRate = optionalInt(1, 100_000_000);

/** Field schemas without defaults: PATCH requests must leave absent fields untouched. */
const fields = {
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  serviceType: z.enum(SERVICE_TYPES),
  kind: z.enum(KINDS),
  price: moneyInput,
  taxRate: percentInput,
  billingUnit: z.enum(BILLING_UNITS),
  billingCount: z.coerce.number().int().min(1).max(1440),
  downloadKbps: optionalRate,
  uploadKbps: optionalRate,
  dataQuotaMb: optionalInt(1, 100_000_000),
  deviceLimit: optionalInt(1, 1000),
  /** PPP / hotspot profile name on the router. Empty on create = a stable name derived from the plan name. */
  networkProfile: z
    .union([z.string().trim().regex(/^[A-Za-z0-9 ._@-]{1,64}$/, "Letters, digits, spaces, dot, dash, @ or underscore (max 64)"), z.literal("").transform(() => null), z.null()])
    .optional(),
  /** LIVE = sold to customers, HIDDEN = staff only, OFF = not sold. */
  availability: z.enum(["LIVE", "HIDDEN", "OFF"]),
  highlight: z.union([z.enum(["POPULAR", "OFFER"]), z.literal("").transform(() => null), z.null()]).optional(),
  sortOrder: z.coerce.number().int().min(0).max(10_000),
  burstDownloadKbps: optionalRate,
  burstUploadKbps: optionalRate,
  burstThresholdDownloadKbps: optionalRate,
  burstThresholdUploadKbps: optionalRate,
  burstTimeSeconds: optionalInt(1, 3600),
  fupEnabled: z.boolean(),
  fupThresholdMb: optionalInt(1, 100_000_000),
  fupAction: z.union([z.enum(["THROTTLE", "DISCONNECT"]), z.null()]).optional(),
  fupDownloadKbps: optionalRate,
  fupUploadKbps: optionalRate,
  scheduleEnabled: z.boolean(),
  scheduleStartMinute: optionalInt(0, 1439),
  scheduleEndMinute: optionalInt(0, 1439),
  scheduleDays: optionalInt(1, 127),
  trialCooldownDays: optionalInt(0, 3650),
  /** NAS restriction: empty = every router. */
  routerIds: z.array(z.uuid()).max(200),
};

export const packageInput = z.object({
  ...fields,
  kind: fields.kind.default("TIME"),
  taxRate: fields.taxRate.default("0"),
  billingUnit: fields.billingUnit.default("MONTH"),
  billingCount: fields.billingCount.default(1),
  availability: fields.availability.optional(),
  sortOrder: fields.sortOrder.optional(),
  fupEnabled: fields.fupEnabled.default(false),
  scheduleEnabled: fields.scheduleEnabled.default(false),
  routerIds: fields.routerIds.optional(),
});

export const packageUpdate = z.object(fields).partial().extend({ status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional() });

export const packageListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED", "ALL"]).default("ALL"),
  serviceType: z.enum(SERVICE_TYPES).optional(),
});

export const PLAN_TYPES = ["HOTSPOT", "PPPOE", "DATA", "TRIAL", "DEVICE", "STATIC_IP", "OTHER"] as const;
export const catalogueQuery = z.object({
  q: z.string().optional(),
  type: z.enum(["ALL", ...PLAN_TYPES]).default("ALL"),
  view: z.enum(["current", "archived"]).default("current"),
});

export const packageSelect = {
  id: true,
  name: true,
  description: true,
  serviceType: true,
  kind: true,
  price: true,
  currency: true,
  taxRate: true,
  billingUnit: true,
  billingCount: true,
  downloadKbps: true,
  uploadKbps: true,
  dataQuotaMb: true,
  deviceLimit: true,
  networkProfile: true,
  status: true,
  listed: true,
  highlight: true,
  sortOrder: true,
  burstDownloadKbps: true,
  burstUploadKbps: true,
  burstThresholdDownloadKbps: true,
  burstThresholdUploadKbps: true,
  burstTimeSeconds: true,
  fupEnabled: true,
  fupThresholdMb: true,
  fupAction: true,
  fupDownloadKbps: true,
  fupUploadKbps: true,
  scheduleEnabled: true,
  scheduleStartMinute: true,
  scheduleEndMinute: true,
  scheduleDays: true,
  trialCooldownDays: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PackageSelect;

type PlanRecord = Prisma.PackageGetPayload<{ select: typeof packageSelect }>;
type PlanShape = Omit<PlanRecord, "id" | "createdAt" | "updatedAt" | "currency" | "price" | "taxRate" | "status" | "listed"> & { price: string };

// ───────── Validation ─────────

/** Business rules for a complete plan (after merging an update). Field paths match the API schema. */
export function planProblems(p: PlanShape): FieldIssue[] {
  const out: FieldIssue[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  if (p.kind !== "TIME" && p.serviceType !== "HOTSPOT") add("kind", "Data bundles, trials and device plans are sold over the hotspot.");
  if (p.kind !== "TRIAL" && !new D(p.price).gt(0)) add("price", "Price must be at least 1. Only trial plans can be free.");
  if (p.billingCount > MAX_DURATION_COUNT[p.billingUnit]) add("billingCount", `At most ${MAX_DURATION_COUNT[p.billingUnit]} for this unit.`);
  if (p.billingUnit === "MINUTE" && p.serviceType !== "HOTSPOT") add("billingUnit", "Durations in minutes are for hotspot plans.");
  if (Boolean(p.downloadKbps) !== Boolean(p.uploadKbps)) add("uploadKbps", "Set both the upload and the download rate, or neither.");
  if (p.kind === "DATA" && !p.dataQuotaMb) add("dataQuotaMb", "A data bundle needs a data allowance.");
  const burstFields = [p.burstDownloadKbps, p.burstUploadKbps, p.burstThresholdDownloadKbps, p.burstThresholdUploadKbps, p.burstTimeSeconds];
  const set = burstFields.filter((v) => v !== null && v !== undefined).length;
  if (set !== 0 && set !== burstFields.length) add("burstDownloadKbps", "Fill in the burst limit, threshold and time, or leave all of them empty.");
  else if (hasBurst(p)) {
    const problem = burstProblem(p);
    if (problem) add("burstDownloadKbps", problem);
  }
  if (p.fupEnabled) {
    if (!p.fupThresholdMb) add("fupThresholdMb", "Set the data usage that triggers the policy.");
    if (!p.fupAction) add("fupAction", "Choose what happens when the limit is reached.");
    if (p.fupAction === "THROTTLE") {
      if (!p.fupDownloadKbps || !p.fupUploadKbps) add("fupDownloadKbps", "Set the reduced speed.");
      else if (p.downloadKbps && p.uploadKbps && (p.fupDownloadKbps >= p.downloadKbps || p.fupUploadKbps >= p.uploadKbps)) add("fupDownloadKbps", "The reduced speed must be lower than the plan speed.");
    }
  }
  if (p.scheduleEnabled) {
    if (p.scheduleStartMinute === null || p.scheduleStartMinute === undefined || p.scheduleEndMinute === null || p.scheduleEndMinute === undefined) add("scheduleStartMinute", "Set the start and end time.");
    else if (p.scheduleStartMinute === p.scheduleEndMinute) add("scheduleEndMinute", "The end time must differ from the start time.");
  }
  return out;
}

function assertValidPlan(p: PlanShape) {
  const problems = planProblems(p);
  if (problems.length) throw new AppError("VALIDATION_ERROR", problems[0]!.message, { fields: problems });
}

function statusFields(availability: Availability | undefined): { status?: "ACTIVE" | "INACTIVE"; listed?: boolean } {
  if (availability === "LIVE") return { status: "ACTIVE", listed: true };
  if (availability === "HIDDEN") return { status: "ACTIVE", listed: false };
  if (availability === "OFF") return { status: "INACTIVE" };
  return {};
}

/** Disabled policies keep no stale values, so the CHECK constraints and the UI agree with what is enforced. */
function normalisePolicies<T extends Partial<PlanShape>>(p: T): T {
  const out = { ...p };
  if (out.fupEnabled === false) Object.assign(out, { fupThresholdMb: null, fupAction: null, fupDownloadKbps: null, fupUploadKbps: null });
  if (out.fupAction === "DISCONNECT") Object.assign(out, { fupDownloadKbps: null, fupUploadKbps: null });
  if (out.scheduleEnabled === false) Object.assign(out, { scheduleStartMinute: null, scheduleEndMinute: null, scheduleDays: null });
  if (out.kind !== undefined && out.kind !== "TRIAL") out.trialCooldownDays = null;
  return out;
}

async function assertRouters(client: Tx | typeof db, organizationId: string, routerIds: string[]) {
  if (!routerIds.length) return;
  const found = await client.router.count({ where: { id: { in: routerIds }, organizationId, archivedAt: null } });
  if (found !== new Set(routerIds).size) throw new AppError("VALIDATION_ERROR", "Choose routers from this organization.", { fields: [{ path: "routerIds", message: "Unknown or archived router" }] });
}

// ───────── Router profiles ─────────

const NETWORK_FIELDS = ["name", "networkProfile", "serviceType", "downloadKbps", "uploadKbps", "deviceLimit", "burstDownloadKbps", "burstUploadKbps", "burstThresholdDownloadKbps", "burstThresholdUploadKbps", "burstTimeSeconds"] as const;

/** Routers a plan is used on: enabled for its access technology, not archived, and allowed by the NAS restriction. */
export async function routersForPlan(client: Tx | typeof db, pkg: Pick<Package, "id" | "organizationId" | "serviceType">) {
  if (pkg.serviceType !== "PPPOE" && pkg.serviceType !== "HOTSPOT") return [];
  const restricted = await client.packageRouter.findMany({ where: { packageId: pkg.id }, select: { routerId: true } });
  return client.router.findMany({
    where: {
      organizationId: pkg.organizationId,
      archivedAt: null,
      ...(pkg.serviceType === "PPPOE" ? { pppoeEnabled: true } : { hotspotEnabled: true }),
      ...(restricted.length ? { id: { in: restricted.map((r) => r.routerId) } } : {}),
    },
    select: { id: true, name: true },
  });
}

/** Queue a profile push to each router the plan is used on. Without a speed there is nothing for Cloudlink to manage. */
async function queuePlanSyncTx(tx: Tx, ctx: ActorContext, pkg: Package, reason: string, manual = false) {
  if (pkg.status === "ARCHIVED" || !routerRateLimit(pkg)) return [];
  const routers = await routersForPlan(tx, pkg);
  const ops = [];
  for (const router of routers) {
    ops.push(
      await requestNetworkOperationTx(tx, ctx, {
        type: "profile.sync",
        routerId: router.id,
        params: { packageId: pkg.id, profile: pkg.networkProfile || pkg.name, rateLimit: routerRateLimit(pkg), reason },
        idempotencyKey: manual ? `profile:${pkg.id}:${router.id}:manual:${randomUUID()}` : `profile:${pkg.id}:${router.id}:${pkg.updatedAt.getTime()}`,
      }),
    );
  }
  return ops;
}

/** Staff: push a plan to its routers now. */
export async function syncPackageToRouters(ctx: StaffContext, id: string) {
  requirePermission(ctx, "packages.read", "network.operate");
  const pkg = await db.package.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!pkg) throw notFound("package");
  if (pkg.status === "ARCHIVED") throw new AppError("INVALID_STATE", "Archived plans are not pushed to routers.");
  if (!routerRateLimit(pkg)) throw new AppError("INVALID_STATE", "This plan has no speed limit, so there is no router profile to push.");
  const ops = await db.$transaction((tx) => queuePlanSyncTx(tx, ctx, pkg, "Pushed by staff", true));
  if (!ops.length) throw new AppError("INVALID_STATE", `No router uses this plan. Enable ${pkg.serviceType === "PPPOE" ? "PPPoE" : "hotspot"} on a router or adjust the router restriction.`);
  await dispatchNetworkOperations(ctx.organizationId, { ids: ops.map((o) => o.id) });
  await audit(ctx, { action: "package.sync", entityType: "package", entityId: id, metadata: { routers: ops.length } });
  return { queued: ops.length };
}

/** Staff: push every plan a router uses (e.g. after onboarding a router). */
export async function syncRouterPlans(ctx: StaffContext, routerId: string) {
  requirePermission(ctx, "network.operate");
  const router = await db.router.findFirst({ where: { id: routerId, organizationId: ctx.organizationId, archivedAt: null, ...(ctx.branchIds ? { OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] } : {}) } });
  if (!router) throw notFound("router");
  const plans = await db.package.findMany({ where: { organizationId: ctx.organizationId, status: { in: ["ACTIVE", "INACTIVE"] }, serviceType: { in: [...(router.pppoeEnabled ? ["PPPOE" as const] : []), ...(router.hotspotEnabled ? ["HOTSPOT" as const] : [])] } } });
  const ops = await db.$transaction(async (tx) => {
    const out = [];
    for (const pkg of plans) {
      const targets = await routersForPlan(tx, pkg);
      if (!routerRateLimit(pkg) || !targets.some((t) => t.id === router.id)) continue;
      out.push(
        await requestNetworkOperationTx(tx, ctx, {
          type: "profile.sync",
          routerId: router.id,
          params: { packageId: pkg.id, profile: pkg.networkProfile || pkg.name, rateLimit: routerRateLimit(pkg), reason: "Router plan sync" },
          idempotencyKey: `profile:${pkg.id}:${router.id}:manual:${randomUUID()}`,
        }),
      );
    }
    return out;
  });
  await dispatchNetworkOperations(ctx.organizationId, { ids: ops.map((o) => o.id) });
  await audit(ctx, { action: "router.sync_plans", entityType: "router", entityId: routerId, metadata: { plans: ops.length } });
  return { queued: ops.length };
}

/** Routers a plan can be limited to (management addresses only for staff who may see routers). */
export async function planRouterChoices(ctx: StaffContext) {
  requirePermission(ctx, "packages.read");
  const rows = await db.router.findMany({
    where: { organizationId: ctx.organizationId, archivedAt: null },
    select: { id: true, name: true, host: true, pppoeEnabled: true, hotspotEnabled: true },
    orderBy: { name: "asc" },
  });
  const showHost = hasPermission(ctx, "routers.read");
  return rows.map((r) => ({ ...r, host: showHost ? r.host : "" }));
}

// ───────── Queries ─────────

export async function listPackages(ctx: ActorContext, query: z.infer<typeof packageListQuery>) {
  requirePermission(ctx, "packages.read");
  const q = searchTerm(query.q);
  const where: Prisma.PackageWhereInput = {
    organizationId: ctx.organizationId,
    ...(query.status !== "ALL" ? { status: query.status } : { status: { not: "ARCHIVED" } }),
    ...(query.serviceType ? { serviceType: query.serviceType } : {}),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
  };
  const rows = await db.package.findMany({
    where,
    select: { ...packageSelect, _count: { select: { subscriptions: { where: { status: { in: ["ACTIVE", "SUSPENDED"] } } } } } },
    orderBy: [{ status: "asc" }, { sortOrder: "asc" }, { price: "asc" }],
  });
  return rows.map(({ _count, ...p }) => ({ ...p, activeSubscriptions: _count.subscriptions }));
}

/**
 * Revenue per plan over the last 30 days: fully paid invoice lines for the plan (gross) plus redeemed vouchers of
 * the plan (face value). Branch-scoped like the caller's other financial views.
 */
async function revenue30d(ctx: ActorContext): Promise<Map<string, string>> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [invoiced, vouchers] = await Promise.all([
    db.$queryRaw<Array<{ packageId: string; total: Prisma.Decimal }>>`
      SELECT il."packageId", SUM(il."lineTotal") AS total
      FROM "InvoiceLine" il JOIN "Invoice" i ON i."id" = il."invoiceId"
      WHERE i."organizationId" = ${ctx.organizationId}::uuid AND i."status" = 'PAID' AND i."paidAt" >= ${since} AND il."packageId" IS NOT NULL
      ${branchFilterSql(ctx, Prisma.sql`i."branchId"`)}
      GROUP BY il."packageId"`,
    db.$queryRaw<Array<{ packageId: string; total: Prisma.Decimal }>>`
      SELECT b."packageId", SUM(r."faceValue") AS total
      FROM "VoucherRedemption" r JOIN "VoucherBatch" b ON b."id" = r."batchId"
      WHERE r."organizationId" = ${ctx.organizationId}::uuid AND r."createdAt" >= ${since}
      ${branchFilterSql(ctx, Prisma.sql`b."branchId"`)}
      GROUP BY b."packageId"`,
  ]);
  const out = new Map<string, string>();
  for (const row of [...invoiced, ...vouchers]) out.set(row.packageId, new D(out.get(row.packageId) ?? 0).plus(new D(row.total.toString())).toFixed(2));
  return out;
}

/** The plans page: rows with type, availability, live subscriptions and revenue, plus headline counts. */
export async function packageCatalogue(ctx: StaffContext, query: z.infer<typeof catalogueQuery>) {
  requirePermission(ctx, "packages.read");
  const q = searchTerm(query.q);
  const scope = ctx.activeBranchId ? { branchId: ctx.activeBranchId } : ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {};
  const all = await db.package.findMany({
    where: { organizationId: ctx.organizationId, status: query.view === "archived" ? "ARCHIVED" : { not: "ARCHIVED" } },
    select: {
      ...packageSelect,
      routers: { select: { routerId: true } },
      _count: { select: { subscriptions: { where: { status: { in: ["ACTIVE", "SUSPENDED"] }, ...scope } } } },
    },
    orderBy: [{ sortOrder: "asc" }, { serviceType: "asc" }, { price: "asc" }, { name: "asc" }],
  });
  const canSeeRevenue = hasPermission(ctx, "payments.read") || hasPermission(ctx, "reports.read");
  const revenue = canSeeRevenue ? await revenue30d(ctx) : null;
  const decorated = all.map(({ _count, routers, ...p }) => ({
    ...p,
    planType: planTypeOf(p.serviceType, p.kind) as PlanType,
    availability: availabilityOf(p.status, p.listed),
    activeSubscriptions: _count.subscriptions,
    routerIds: routers.map((r) => r.routerId),
    revenue30d: revenue ? (revenue.get(p.id) ?? "0.00") : null,
  }));
  const typeCounts = Object.fromEntries(PLAN_TYPES.map((t) => [t, decorated.filter((p) => p.planType === t).length])) as Record<PlanType, number>;
  const rows = decorated.filter((p) => (query.type === "ALL" || p.planType === query.type) && (!q || p.name.toLowerCase().includes(q.toLowerCase())));
  return {
    rows,
    typeCounts,
    stats: {
      all: decorated.length,
      live: decorated.filter((p) => p.availability === "LIVE").length,
      hidden: decorated.filter((p) => p.availability === "HIDDEN").length,
      off: decorated.filter((p) => p.availability === "OFF").length,
      subscribers: decorated.reduce((a, p) => a + p.activeSubscriptions, 0),
      plansWithSubscribers: decorated.filter((p) => p.activeSubscriptions > 0).length,
    },
  };
}

export async function getPackage(ctx: ActorContext, id: string) {
  requirePermission(ctx, "packages.read");
  const pkg = await db.package.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { ...packageSelect, routers: { select: { routerId: true } } } });
  if (!pkg) throw notFound("package");
  const { routers, ...rest } = pkg;
  return { ...rest, routerIds: routers.map((r) => r.routerId), availability: availabilityOf(pkg.status, pkg.listed), planType: planTypeOf(pkg.serviceType, pkg.kind) };
}

// ───────── Mutations ─────────

function shapeOf(p: PlanRecord | (z.infer<typeof packageInput> & { networkProfile?: string | null })): PlanShape {
  return {
    name: p.name,
    description: p.description ?? null,
    serviceType: p.serviceType,
    kind: p.kind,
    price: p.price.toString(),
    billingUnit: p.billingUnit,
    billingCount: p.billingCount,
    downloadKbps: p.downloadKbps ?? null,
    uploadKbps: p.uploadKbps ?? null,
    dataQuotaMb: p.dataQuotaMb ?? null,
    deviceLimit: p.deviceLimit ?? null,
    networkProfile: p.networkProfile ?? null,
    highlight: p.highlight ?? null,
    sortOrder: p.sortOrder ?? 0,
    burstDownloadKbps: p.burstDownloadKbps ?? null,
    burstUploadKbps: p.burstUploadKbps ?? null,
    burstThresholdDownloadKbps: p.burstThresholdDownloadKbps ?? null,
    burstThresholdUploadKbps: p.burstThresholdUploadKbps ?? null,
    burstTimeSeconds: p.burstTimeSeconds ?? null,
    fupEnabled: p.fupEnabled,
    fupThresholdMb: p.fupThresholdMb ?? null,
    fupAction: p.fupAction ?? null,
    fupDownloadKbps: p.fupDownloadKbps ?? null,
    fupUploadKbps: p.fupUploadKbps ?? null,
    scheduleEnabled: p.scheduleEnabled,
    scheduleStartMinute: p.scheduleStartMinute ?? null,
    scheduleEndMinute: p.scheduleEndMinute ?? null,
    scheduleDays: p.scheduleDays ?? null,
    trialCooldownDays: p.trialCooldownDays ?? null,
  };
}

function uniqueNameError(err: unknown): never {
  if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "A plan with this name already exists.", { fields: [{ path: "name", message: "Already in use" }] });
  throw err;
}

export async function createPackage(ctx: ActorContext, raw: z.input<typeof packageInput>) {
  requirePermission(ctx, "packages.write");
  const input = normalisePolicies(packageInput.parse(raw));
  assertValidPlan(shapeOf(input));
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { currency: true } });
  const { availability, routerIds = [], ...data } = input;
  await assertRouters(db, ctx.organizationId, routerIds);
  const { pkg, ops } = await db
    .$transaction(async (tx) => {
      const pkg = await tx.package.create({
        data: {
          ...data,
          ...statusFields(availability ?? "LIVE"),
          organizationId: ctx.organizationId,
          currency: org.currency,
          description: input.description ?? null,
          networkProfile: input.networkProfile || defaultProfileName(input.name),
          ...(routerIds.length ? { routers: { create: [...new Set(routerIds)].map((routerId) => ({ routerId, organizationId: ctx.organizationId })) } } : {}),
        },
      });
      return { pkg, ops: await queuePlanSyncTx(tx, ctx, pkg, "Plan created") };
    })
    .catch(uniqueNameError);
  if (ops.length) await dispatchNetworkOperations(ctx.organizationId, { ids: ops.map((o) => o.id) });
  await audit(ctx, { action: "package.create", entityType: "package", entityId: pkg.id, metadata: { name: pkg.name, price: pkg.price.toString(), currency: pkg.currency, kind: pkg.kind, routers: routerIds.length, profileSyncs: ops.length } });
  return getPackage(ctx, pkg.id);
}

/**
 * Update a plan. Price/terms changes apply to new subscriptions only: existing subscriptions keep their
 * commercial snapshot, so issued and future invoices for them are unaffected. Network changes are pushed to routers.
 */
export async function updatePackage(ctx: ActorContext, id: string, raw: z.input<typeof packageUpdate>) {
  requirePermission(ctx, "packages.write");
  const input = normalisePolicies(packageUpdate.parse(raw));
  const before = await db.package.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { ...packageSelect, routers: { select: { routerId: true } } } });
  if (!before) throw notFound("package");
  const { availability, routerIds, status, ...changes } = input;
  const merged = normalisePolicies({ ...shapeOf(before), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) } as PlanShape);
  assertValidPlan(merged);
  const nextStatus = status ?? statusFields(availability).status;
  if (nextStatus === "ARCHIVED") {
    const live = await db.subscription.count({ where: { packageId: id, status: { in: ["ACTIVE", "SUSPENDED", "PENDING"] } } });
    if (live > 0) throw new AppError("INVALID_STATE", `This plan has ${live} live subscription(s). Move them to another plan before archiving.`);
  }
  if (routerIds) await assertRouters(db, ctx.organizationId, routerIds);
  const data: Prisma.PackageUpdateInput = { ...changes, ...statusFields(availability), ...(status ? { status } : {}) };
  const beforeRouters = before.routers.map((r) => r.routerId).sort();
  const routersChanged = routerIds !== undefined && JSON.stringify([...new Set(routerIds)].sort()) !== JSON.stringify(beforeRouters);
  const { pkg, ops } = await db
    .$transaction(async (tx) => {
      const pkg = await tx.package.update({ where: { id }, data });
      if (routersChanged) {
        await tx.packageRouter.deleteMany({ where: { packageId: id } });
        if (routerIds!.length) await tx.packageRouter.createMany({ data: [...new Set(routerIds)].map((routerId) => ({ packageId: id, routerId, organizationId: ctx.organizationId })) });
      }
      const networkChanged = routersChanged || NETWORK_FIELDS.some((k) => k in changes && String((before as Record<string, unknown>)[k] ?? "") !== String((pkg as Record<string, unknown>)[k] ?? "")) || (before.status === "ARCHIVED" && pkg.status !== "ARCHIVED");
      return { pkg, ops: networkChanged ? await queuePlanSyncTx(tx, ctx, pkg, "Plan updated") : [] };
    })
    .catch(uniqueNameError);
  if (ops.length) await dispatchNetworkOperations(ctx.organizationId, { ids: ops.map((o) => o.id) });
  const changed = Object.keys(data).filter((k) => String((before as Record<string, unknown>)[k] ?? "") !== String((pkg as Record<string, unknown>)[k] ?? ""));
  await audit(ctx, {
    action: "package.update",
    entityType: "package",
    entityId: id,
    metadata: {
      changed: routersChanged ? [...changed, "routers"] : changed,
      before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
      after: Object.fromEntries(changed.map((k) => [k, (pkg as Record<string, unknown>)[k]])),
      profileSyncs: ops.length,
    },
  });
  return getPackage(ctx, id);
}

/** Copy a plan as a starting point for a new one. The copy is Off until reviewed and gets its own router profile. */
export async function duplicatePackage(ctx: ActorContext, id: string) {
  requirePermission(ctx, "packages.write");
  const src = await db.package.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { ...packageSelect, routers: { select: { routerId: true } } } });
  if (!src) throw notFound("package");
  const taken = new Set((await db.package.findMany({ where: { organizationId: ctx.organizationId, name: { startsWith: src.name.slice(0, 60) } }, select: { name: true } })).map((p) => p.name));
  let name = `${src.name.slice(0, 70)} (copy)`;
  for (let i = 2; taken.has(name); i++) name = `${src.name.slice(0, 66)} (copy ${i})`;
  const copy = await db.package
    .create({
      data: {
        ...shapeOf(src),
        name,
        price: src.price,
        taxRate: src.taxRate,
        currency: src.currency,
        organizationId: ctx.organizationId,
        status: "INACTIVE",
        listed: src.listed,
        networkProfile: defaultProfileName(name),
        ...(src.routers.length ? { routers: { create: src.routers.map((r) => ({ routerId: r.routerId, organizationId: ctx.organizationId })) } } : {}),
      },
    })
    .catch(uniqueNameError);
  await audit(ctx, { action: "package.duplicate", entityType: "package", entityId: copy.id, metadata: { from: id, name } });
  return getPackage(ctx, copy.id);
}
