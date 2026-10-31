import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { listWhere, requirePermission, resolveBranchForCreate, tenantWhere, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { searchTerm } from "@/server/services/common";
import { dispatchOperation, enqueueOperation } from "@/server/jobs/operations";
import { tr069Adapter, tr069AdapterName } from "@/server/integrations/tr069";
import type { Prisma } from "@/generated/prisma/client";

/**
 * TR-069 devices (Devices → TR-069). Staff enrol customer devices by serial number and assign them to subscribers;
 * the worker reads their status from the ACS every five minutes (integrations/tr069.ts). A device is
 *  - "checked in" when its last inform is under an hour old,
 *  - "not answering" when it informed before but not within the hour,
 *  - "never seen" when the ACS has no inform for it,
 * and has a weak signal when its optical receive power is below -27 dBm.
 */
export const STALE_AFTER_MS = 60 * 60_000;
export const WEAK_SIGNAL_DBM = -27;

export type DeviceState = "CHECKED_IN" | "NOT_ANSWERING" | "NEVER_SEEN";
export function deviceState(lastInformAt: Date | null, now = new Date()): DeviceState {
  if (!lastInformAt) return "NEVER_SEEN";
  return now.getTime() - lastInformAt.getTime() < STALE_AFTER_MS ? "CHECKED_IN" : "NOT_ANSWERING";
}

/** Where CPEs connect and how they log in (deployment settings; the ACS password is never shown). */
export function acsInfo() {
  return { acsUrl: process.env.TR069_ACS_URL || null, acsUsername: process.env.TR069_ACS_USERNAME || null, adapter: tr069AdapterName() };
}

export const tr069ListQuery = z.object({
  tab: z.enum(["all", "not_answering", "never_seen", "weak_signal"]).default("all"),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const serial = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, "Letters, digits and . _ : - only");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();

export const enrolInput = z.object({
  serialNumber: serial,
  manufacturer: optionalText(64),
  productClass: optionalText(64),
  label: optionalText(80),
  subscriberId: z.uuid().nullable().optional(),
});
export const deviceUpdateInput = z.object({ label: optionalText(80), subscriberId: z.uuid().nullable().optional() });

const deviceSelect = {
  id: true,
  serialNumber: true,
  manufacturer: true,
  productClass: true,
  softwareVersion: true,
  label: true,
  subscriberId: true,
  lastInformAt: true,
  rxPowerDbm: true,
  ipAddress: true,
  simulated: true,
  lastSyncedAt: true,
  createdAt: true,
} satisfies Prisma.Tr069DeviceSelect;

function staleBefore(now: Date) {
  return new Date(now.getTime() - STALE_AFTER_MS);
}

export async function listTr069Devices(ctx: StaffContext, query: z.infer<typeof tr069ListQuery>) {
  requirePermission(ctx, "inventory.read");
  const now = new Date();
  const base: Prisma.Tr069DeviceWhereInput = listWhere(ctx);
  const tabs: Record<typeof query.tab, Prisma.Tr069DeviceWhereInput> = {
    all: {},
    not_answering: { lastInformAt: { not: null, lt: staleBefore(now) } },
    never_seen: { lastInformAt: null },
    weak_signal: { rxPowerDbm: { lt: WEAK_SIGNAL_DBM } },
  };
  const q = searchTerm(query.q);
  const where: Prisma.Tr069DeviceWhereInput = {
    ...base,
    ...tabs[query.tab],
    ...(q ? { OR: [{ serialNumber: { contains: q, mode: "insensitive" } }, { label: { contains: q, mode: "insensitive" } }, { productClass: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total, devices, checkedIn, neverSeen, weakSignal] = await Promise.all([
    db.tr069Device.findMany({ where, select: deviceSelect, orderBy: [{ lastInformAt: { sort: "desc", nulls: "last" } }, { serialNumber: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.tr069Device.count({ where }),
    db.tr069Device.count({ where: base }),
    db.tr069Device.count({ where: { ...base, lastInformAt: { gte: staleBefore(now) } } }),
    db.tr069Device.count({ where: { ...base, lastInformAt: null } }),
    db.tr069Device.count({ where: { ...base, rxPowerDbm: { lt: WEAK_SIGNAL_DBM } } }),
  ]);
  const subscriberIds = [...new Set(rows.map((r) => r.subscriberId).filter((v): v is string => Boolean(v)))];
  const subscribers = subscriberIds.length
    ? await db.subscriber.findMany({ where: { id: { in: subscriberIds }, organizationId: ctx.organizationId }, select: { id: true, displayName: true, accountNumber: true } })
    : [];
  return {
    rows: rows.map((r) => ({
      ...r,
      rxPowerDbm: r.rxPowerDbm === null ? null : Number(r.rxPowerDbm),
      state: deviceState(r.lastInformAt, now),
      weakSignal: r.rxPowerDbm !== null && Number(r.rxPowerDbm) < WEAK_SIGNAL_DBM,
      subscriber: subscribers.find((s) => s.id === r.subscriberId) ?? null,
    })),
    total,
    summary: { devices, checkedIn, notAnswering: devices - checkedIn - neverSeen, neverSeen, weakSignal },
    acs: acsInfo(),
  };
}

/** Firmware versions across the organization's devices, by model. */
export async function firmwareSummary(ctx: StaffContext) {
  requirePermission(ctx, "inventory.read");
  const groups = await db.tr069Device.groupBy({ by: ["productClass", "softwareVersion"], where: listWhere(ctx), _count: { _all: true }, orderBy: [{ productClass: "asc" }, { softwareVersion: "asc" }] });
  return groups.map((g) => ({ model: g.productClass, version: g.softwareVersion, devices: g._count._all }));
}

async function subscriberFor(ctx: StaffContext, id: string | null | undefined) {
  if (!id) return null;
  const s = await db.subscriber.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { id: true, branchId: true } });
  if (!s) throw new AppError("VALIDATION_ERROR", "Subscriber not found.", { fields: [{ path: "subscriberId", message: "Not found" }] });
  return s;
}

export async function enrolTr069Device(ctx: StaffContext, raw: z.input<typeof enrolInput>) {
  requirePermission(ctx, "inventory.write");
  const input = enrolInput.parse(raw);
  const subscriber = await subscriberFor(ctx, input.subscriberId);
  const branchId = subscriber ? subscriber.branchId : await resolveBranchForCreate(ctx, null);
  const device = await db.tr069Device
    .create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        serialNumber: input.serialNumber,
        manufacturer: input.manufacturer ?? null,
        productClass: input.productClass ?? null,
        label: input.label ?? null,
        subscriberId: subscriber?.id ?? null,
        createdById: ctx.userId,
      },
      select: deviceSelect,
    })
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "This serial number is already enrolled.", { fields: [{ path: "serialNumber", message: "Already enrolled" }] });
      throw err;
    });
  await audit(ctx, { action: "tr069.device.enrol", entityType: "tr069_device", entityId: device.id, metadata: { serialNumber: device.serialNumber, subscriberId: device.subscriberId } });
  // Read its status from the ACS straight away rather than at the next five-minute run.
  if (tr069AdapterName() !== "disabled") await requestSync(ctx).catch(() => undefined);
  return device;
}

async function findDevice(ctx: StaffContext, id: string) {
  const device = await db.tr069Device.findFirst({ where: { id, ...tenantWhere(ctx) }, select: { ...deviceSelect, branchId: true } });
  if (!device) throw notFound("device");
  return device;
}

export async function updateTr069Device(ctx: StaffContext, id: string, raw: z.input<typeof deviceUpdateInput>) {
  requirePermission(ctx, "inventory.write");
  const input = deviceUpdateInput.parse(raw);
  const current = await findDevice(ctx, id);
  const data: Prisma.Tr069DeviceUpdateInput = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.subscriberId !== undefined) {
    const subscriber = await subscriberFor(ctx, input.subscriberId);
    data.subscriberId = subscriber?.id ?? null;
    data.branchId = subscriber ? subscriber.branchId : current.branchId;
  }
  const device = await db.tr069Device.update({ where: { id }, data, select: deviceSelect });
  await audit(ctx, { action: "tr069.device.update", entityType: "tr069_device", entityId: id, metadata: { changed: Object.keys(data), subscriberId: device.subscriberId } });
  return device;
}

export async function removeTr069Device(ctx: StaffContext, id: string) {
  requirePermission(ctx, "inventory.write");
  const device = await findDevice(ctx, id);
  await db.tr069Device.delete({ where: { id } });
  await audit(ctx, { action: "tr069.device.remove", entityType: "tr069_device", entityId: id, metadata: { serialNumber: device.serialNumber } });
  return { removed: true };
}

/** Ask the worker to read the organization's devices from the ACS now (at most once every 30 seconds). */
async function requestSync(ctx: StaffContext) {
  const bucket = Math.floor(Date.now() / 30_000);
  const op = await enqueueOperation({ type: "tr069.sync", organizationId: ctx.organizationId, payload: { manual: true }, dedupeKey: `tr069.sync:${ctx.organizationId}:manual:${bucket}`, maxAttempts: 1, correlationId: ctx.correlationId });
  await dispatchOperation(op);
  return op;
}

export async function requestTr069Sync(ctx: StaffContext) {
  requirePermission(ctx, "inventory.read");
  if (tr069AdapterName() === "disabled") throw new AppError("INVALID_STATE", "No ACS is connected to this deployment (TR069_ADAPTER=disabled).");
  const op = await requestSync(ctx);
  return { queued: true, operationId: op.id };
}

/** Worker: read every enrolled device of the organization from the ACS and record what it reports. */
export async function syncTr069Devices(organizationId: string) {
  const adapter = tr069Adapter();
  if (adapter.name === "disabled") return { checked: 0, seen: 0, adapter: adapter.name };
  const devices = await db.tr069Device.findMany({ where: { organizationId }, select: { id: true, serialNumber: true } });
  if (!devices.length) return { checked: 0, seen: 0, adapter: adapter.name };
  const found = await adapter.fetchDevices(devices.map((d) => d.serialNumber));
  const now = new Date();
  let seen = 0;
  for (const d of devices) {
    const acs = found.find((f) => f.serialNumber === d.serialNumber);
    if (!acs) {
      await db.tr069Device.update({ where: { id: d.id }, data: { lastSyncedAt: now } });
      continue;
    }
    seen++;
    await db.tr069Device.update({
      where: { id: d.id },
      data: {
        acsDeviceId: acs.acsId,
        manufacturer: acs.manufacturer ?? undefined,
        oui: acs.oui ?? undefined,
        productClass: acs.productClass ?? undefined,
        softwareVersion: acs.softwareVersion ?? undefined,
        lastInformAt: acs.lastInformAt,
        rxPowerDbm: acs.rxPowerDbm === null ? null : acs.rxPowerDbm.toFixed(2),
        ipAddress: acs.ipAddress,
        simulated: Boolean(acs.simulated),
        lastSyncedAt: now,
      },
    });
  }
  return { checked: devices.length, seen, adapter: adapter.name };
}
