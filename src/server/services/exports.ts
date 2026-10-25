import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db/client";
import { loadStaffContext, requirePermission, type StaffContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, notFound } from "@/server/errors";
import { csvCell } from "@/server/domain/csv";
import { enqueueOperation, PermanentError } from "@/server/jobs/operations";
import { storage } from "@/server/integrations/storage";
import { formatPhone } from "@/server/domain/contact";
import type { PermissionKey } from "@/server/auth/permissions";
import { receivablesAging, reportRangeQuery, revenueReport } from "@/server/services/reports";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Exports run in the worker: the request creates an ExportJob (audited), the worker writes a CSV to storage,
 * and the authenticated download link works until `expiresAt` (24 h). Every download is audited.
 * The worker re-checks the requester's current permissions before generating the file.
 */
export const EXPORT_TYPES = {
  subscribers: { label: "Subscribers", permission: "subscribers.read" },
  invoices: { label: "Invoices", permission: "invoices.read" },
  payments: { label: "Payments", permission: "payments.read" },
  receivables_aging: { label: "Receivables aging", permission: "reports.read" },
  revenue: { label: "Revenue by month", permission: "reports.read" },
  audit_logs: { label: "Audit log", permission: "audit.read" },
} as const satisfies Record<string, { label: string; permission: PermissionKey }>;

export type ExportType = keyof typeof EXPORT_TYPES;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 50_000;

export const exportRequestInput = z.object({
  type: z.enum(Object.keys(EXPORT_TYPES) as [ExportType, ...ExportType[]]),
  params: z
    .object({ from: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), to: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), status: z.string().max(30).optional() })
    .default({}),
});

export async function requestExport(ctx: StaffContext, input: z.infer<typeof exportRequestInput>) {
  requirePermission(ctx, "reports.export", EXPORT_TYPES[input.type].permission);
  const job = await db.$transaction(async (tx) => {
    const j = await tx.exportJob.create({ data: { organizationId: ctx.organizationId, type: input.type, params: input.params as Prisma.InputJsonValue, requestedById: ctx.userId } });
    await enqueueOperation({ type: "exports.generate", organizationId: ctx.organizationId, payload: { exportJobId: j.id }, dedupeKey: `export:${j.id}`, maxAttempts: 3 }, tx);
    return j;
  });
  await audit(ctx, { action: "export.request", entityType: "export_job", entityId: job.id, metadata: { type: input.type, params: input.params } });
  return job;
}

function toCsv(header: string[], rows: unknown[][]): Buffer {
  const lines = [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

function dateRange(params: { from?: string; to?: string }): Prisma.DateTimeFilter | undefined {
  const f: Prisma.DateTimeFilter = {};
  if (params.from) f.gte = new Date(params.from.length === 7 ? `${params.from}-01` : params.from);
  if (params.to) f.lte = new Date(params.to.length === 7 ? `${params.to}-28T23:59:59Z` : `${params.to}T23:59:59Z`);
  return Object.keys(f).length ? f : undefined;
}

async function buildCsv(ctx: StaffContext, type: ExportType, params: { from?: string; to?: string; status?: string }): Promise<{ csv: Buffer; rows: number }> {
  const org = ctx.organizationId;
  const branch = ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {};
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");
  switch (type) {
    case "subscribers": {
      const rows = await db.subscriber.findMany({ where: { organizationId: org, ...branch, createdAt: dateRange(params) }, orderBy: { accountNumber: "asc" }, take: MAX_ROWS });
      return { csv: toCsv(["account_number", "name", "type", "phone", "email", "status", "created_at"], rows.map((s) => [s.accountNumber, s.displayName, s.type, formatPhone(s.phone), s.email ?? "", s.status, iso(s.createdAt)])), rows: rows.length };
    }
    case "invoices": {
      const rows = await db.invoice.findMany({ where: { organizationId: org, ...branch, status: { not: "DRAFT" }, issuedAt: dateRange(params) }, orderBy: { issuedAt: "asc" }, take: MAX_ROWS });
      const subs = new Map((await db.subscriber.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subscriberId))] } }, select: { id: true, accountNumber: true, displayName: true } })).map((s) => [s.id, s]));
      return {
        csv: toCsv(
          ["invoice_number", "account_number", "subscriber", "status", "issued_at", "due_at", "currency", "subtotal", "discount", "tax", "total", "paid", "credited", "balance"],
          rows.map((i) => [i.invoiceNumber, subs.get(i.subscriberId)?.accountNumber, subs.get(i.subscriberId)?.displayName, i.status, iso(i.issuedAt), iso(i.dueAt), i.currency, i.subtotal, i.discountTotal, i.taxTotal, i.total, i.amountPaid, i.amountCredited, i.balanceDue].map((v) => (v === undefined || v === null ? "" : v.toString()))),
        ),
        rows: rows.length,
      };
    }
    case "payments": {
      const rows = await db.payment.findMany({ where: { organizationId: org, ...branch, receivedAt: dateRange(params) }, orderBy: { receivedAt: "asc" }, take: MAX_ROWS });
      const subs = new Map((await db.subscriber.findMany({ where: { id: { in: rows.map((r) => r.subscriberId).filter((v): v is string => Boolean(v)) } }, select: { id: true, accountNumber: true } })).map((s) => [s.id, s]));
      return {
        csv: toCsv(
          ["receipt_number", "received_at", "account_number", "method", "reference", "status", "currency", "amount", "allocated", "refunded"],
          rows.map((p) => [p.receiptNumber ?? "", iso(p.receivedAt), p.subscriberId ? (subs.get(p.subscriberId)?.accountNumber ?? "") : "UNMATCHED", p.method, p.providerTransactionId ?? "", p.status, p.currency, p.amount.toString(), p.allocatedAmount.toString(), p.refundedAmount.toString()]),
        ),
        rows: rows.length,
      };
    }
    case "receivables_aging": {
      const r = await receivablesAging(ctx);
      return { csv: toCsv(["account_number", "subscriber", "current", "1_30", "31_60", "61_90", "90_plus", "total"], r.rows.map((x) => [x.accountNumber, x.name, x.current, x["1-30"], x["31-60"], x["61-90"], x["90+"], x.total])), rows: r.rows.length };
    }
    case "revenue": {
      const r = await revenueReport(ctx, reportRangeQuery.parse({ from: params.from?.slice(0, 7), to: params.to?.slice(0, 7) }));
      return { csv: toCsv(["month", "revenue", "credit_notes", "net_revenue", "tax", "collected", "expenses"], r.months.map((m) => [m.month, m.revenue, m.creditNotes, m.netRevenue, m.tax, m.collected, m.expenses])), rows: r.months.length };
    }
    case "audit_logs": {
      const rows = await db.auditLog.findMany({ where: { organizationId: org, createdAt: dateRange(params) }, orderBy: { createdAt: "asc" }, take: MAX_ROWS });
      const users = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
      return {
        csv: toCsv(["timestamp", "actor", "actor_type", "action", "entity_type", "entity_id", "ip_address", "correlation_id"], rows.map((a) => [iso(a.createdAt), a.actorUserId ? (users.get(a.actorUserId) ?? a.actorUserId) : "", a.actorType, a.action, a.entityType ?? "", a.entityId ?? "", a.ipAddress ?? "", a.correlationId ?? ""])),
        rows: rows.length,
      };
    }
  }
}

/** Worker handler. Uses the requester's live permissions (a revoked user cannot complete a queued export). */
export async function generateExport(exportJobId: string) {
  const job = await db.exportJob.findUnique({ where: { id: exportJobId } });
  if (!job || job.status === "READY" || job.status === "EXPIRED") return;
  await db.exportJob.update({ where: { id: job.id }, data: { status: "RUNNING" } });
  try {
    // Re-resolve the requester's live membership and permissions (independent of their browser session).
    const user = await db.user.findUnique({ where: { id: job.requestedById }, select: { id: true, name: true, email: true, kind: true, status: true } });
    if (!user || user.status !== "ACTIVE") throw new PermanentError("requester is no longer active", "REQUESTER_UNAVAILABLE");
    const pseudoSession = { id: `export:${job.id}`, userId: user.id, organizationId: job.organizationId, activeBranchId: null, user } as unknown as Parameters<typeof loadStaffContext>[0];
    const ctx = await loadStaffContext(pseudoSession, { correlationId: `export:${job.id}`, ipAddress: null, userAgent: null });
    requirePermission(ctx, "reports.export", EXPORT_TYPES[job.type as ExportType].permission);
    const { csv, rows } = await buildCsv(ctx, job.type as ExportType, job.params as { from?: string; to?: string; status?: string });
    const key = `exports/${job.organizationId}/${randomUUID()}.csv`;
    await storage().put(key, csv, "text/csv");
    const fileName = `cloudlink-${job.type}-${new Date().toISOString().slice(0, 10)}.csv`;
    await db.exportJob.update({ where: { id: job.id }, data: { status: "READY", storageKey: key, fileName, rowCount: rows, completedAt: new Date(), expiresAt: new Date(Date.now() + EXPORT_TTL_MS), error: null } });
  } catch (err) {
    const message = err instanceof PermanentError || err instanceof AppError ? err.message : "Export failed";
    await db.exportJob.update({ where: { id: job.id }, data: { status: "FAILED", error: message.slice(0, 300) } });
    if (!(err instanceof PermanentError || err instanceof AppError)) throw err;
  }
}

export async function listExports(ctx: StaffContext) {
  requirePermission(ctx, "reports.export");
  const rows = await db.exportJob.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 50 });
  const now = new Date();
  return rows.map((r) => ({ ...r, storageKey: undefined, downloadable: r.status === "READY" && !!r.expiresAt && r.expiresAt > now, label: EXPORT_TYPES[r.type as ExportType]?.label ?? r.type }));
}

export async function downloadExport(ctx: StaffContext, id: string) {
  requirePermission(ctx, "reports.export");
  const job = await db.exportJob.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!job) throw notFound("export");
  requirePermission(ctx, EXPORT_TYPES[job.type as ExportType].permission);
  if (job.status !== "READY" || !job.storageKey) throw new AppError("INVALID_STATE", "This export is not ready.");
  if (!job.expiresAt || job.expiresAt < new Date()) {
    await db.exportJob.update({ where: { id }, data: { status: "EXPIRED" } });
    await storage().remove(job.storageKey).catch(() => undefined);
    throw new AppError("INVALID_STATE", "This download link has expired. Request the export again.");
  }
  const data = await storage().get(job.storageKey);
  await db.exportJob.update({ where: { id }, data: { lastDownloadAt: new Date(), downloadCount: { increment: 1 } } });
  await audit(ctx, { action: "export.download", entityType: "export_job", entityId: id, metadata: { type: job.type, rows: job.rowCount } });
  return { data, fileName: job.fileName ?? "export.csv" };
}
