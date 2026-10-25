import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requirePermission, type ActorContext } from "@/server/auth/context";
import { audit } from "@/server/audit/audit";
import { AppError, isAppError, notFound } from "@/server/errors";
import { CsvError, parseCsv } from "@/server/domain/csv";
import { normalizeEmail } from "@/server/domain/contact";
import { lockRow } from "@/server/services/common";
import { createSubscriberTx, subscriberInput } from "@/server/services/subscribers";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Subscriber CSV import.
 * 1. Preview: parse and validate every row (format, branch, package, duplicates in file and in the database).
 *    Nothing is written except the ImportJob record holding the validated rows and row-level errors.
 * 2. Commit: only allowed when the preview has zero errors. All rows are created in ONE transaction,
 *    so an import either fully succeeds or leaves no subscribers behind (no partial commits).
 */
export const IMPORT_COLUMNS = [
  "first_name",
  "last_name",
  "company_name",
  "type",
  "phone",
  "alt_phone",
  "email",
  "id_number",
  "address",
  "area",
  "town",
  "county",
  "branch_code",
  "package",
  "notes",
] as const;

export const importPreviewInput = z.object({
  fileName: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(2_000_000),
});

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export interface ImportRowError {
  row: number; // 1-based data row (excluding header)
  field: string;
  message: string;
}

type NormalizedRow = z.infer<typeof subscriberInput> & { _row: number };

export async function previewSubscriberImport(ctx: ActorContext, input: z.infer<typeof importPreviewInput>) {
  requirePermission(ctx, "subscribers.import");
  let parsed;
  try {
    parsed = parseCsv(input.content, { maxRows: 5000 });
  } catch (err) {
    if (err instanceof CsvError) throw new AppError("VALIDATION_ERROR", err.message);
    throw err;
  }
  const missing = ["phone"].filter((c) => !parsed.headers.includes(c));
  if (missing.length) throw new AppError("VALIDATION_ERROR", `Missing required column(s): ${missing.join(", ")}.`);
  const unknown = parsed.headers.filter((h) => !(IMPORT_COLUMNS as readonly string[]).includes(h));

  const [branches, packages] = await Promise.all([
    db.branch.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, code: true } }),
    db.package.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true } }),
  ]);
  const branchByCode = new Map(branches.map((b) => [b.code.toUpperCase(), b.id]));
  const packageByName = new Map(packages.map((p) => [p.name.toLowerCase(), p.id]));
  const allowedBranches = ctx.kind === "staff" ? ctx.branchIds : null;

  const errors: ImportRowError[] = [];
  const valid: NormalizedRow[] = [];
  const seenPhones = new Map<string, number>();
  const seenEmails = new Map<string, number>();

  parsed.rows.forEach((raw, i) => {
    const rowNo = i + 1;
    const rowErrors: ImportRowError[] = [];
    const type = (raw.type ?? "").toUpperCase() === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL";
    let branchId: string | null = null;
    if (raw.branch_code) {
      branchId = branchByCode.get(raw.branch_code.toUpperCase()) ?? null;
      if (!branchId) rowErrors.push({ row: rowNo, field: "branch_code", message: `Unknown branch code "${raw.branch_code}".` });
      else if (allowedBranches && !allowedBranches.includes(branchId)) rowErrors.push({ row: rowNo, field: "branch_code", message: "Branch is outside your access scope." });
    } else if (allowedBranches) {
      rowErrors.push({ row: rowNo, field: "branch_code", message: "Branch code is required for branch-restricted staff." });
    }
    let packageId: string | null = null;
    if (raw.package) {
      packageId = packageByName.get(raw.package.toLowerCase()) ?? null;
      if (!packageId) rowErrors.push({ row: rowNo, field: "package", message: `Unknown or inactive package "${raw.package}".` });
    }

    const result = subscriberInput.safeParse({
      type,
      firstName: raw.first_name,
      lastName: raw.last_name,
      companyName: raw.company_name,
      email: raw.email,
      phone: raw.phone ?? "",
      altPhone: raw.alt_phone,
      idNumber: raw.id_number,
      notes: raw.notes,
      branchId,
      address: raw.address ? { line1: raw.address, area: raw.area, town: raw.town, county: raw.county } : null,
      packageId,
      activateSubscription: false, // imported subscriptions start PENDING; activate after verification
      allowDuplicateContact: false,
    });
    if (!result.success) {
      for (const issue of result.error.issues) rowErrors.push({ row: rowNo, field: String(issue.path[0] ?? "row"), message: issue.message });
    } else {
      const phone = result.data.phone;
      const email = normalizeEmail(result.data.email);
      if (seenPhones.has(phone)) rowErrors.push({ row: rowNo, field: "phone", message: `Duplicate phone; also on row ${seenPhones.get(phone)}.` });
      else seenPhones.set(phone, rowNo);
      if (email) {
        if (seenEmails.has(email)) rowErrors.push({ row: rowNo, field: "email", message: `Duplicate email; also on row ${seenEmails.get(email)}.` });
        else seenEmails.set(email, rowNo);
      }
      if (!rowErrors.length) valid.push({ ...result.data, _row: rowNo });
    }
    errors.push(...rowErrors);
  });

  // Duplicates against existing subscribers (single query).
  if (valid.length) {
    const phones = valid.map((v) => v.phone);
    const emails = valid.map((v) => normalizeEmail(v.email)).filter((e): e is string => Boolean(e));
    const existing = await db.subscriber.findMany({
      where: { organizationId: ctx.organizationId, status: { not: "ARCHIVED" }, OR: [{ phone: { in: phones } }, ...(emails.length ? [{ emailNormalized: { in: emails } }] : [])] },
      select: { accountNumber: true, phone: true, emailNormalized: true },
    });
    const byPhone = new Map(existing.map((e) => [e.phone, e.accountNumber]));
    const byEmail = new Map(existing.filter((e) => e.emailNormalized).map((e) => [e.emailNormalized!, e.accountNumber]));
    for (const v of valid) {
      const acc = byPhone.get(v.phone);
      if (acc) errors.push({ row: v._row, field: "phone", message: `Phone already belongs to subscriber ${acc}.` });
      const em = normalizeEmail(v.email);
      const accE = em ? byEmail.get(em) : undefined;
      if (accE) errors.push({ row: v._row, field: "email", message: `Email already belongs to subscriber ${accE}.` });
    }
  }

  const errorRowSet = new Set(errors.map((e) => e.row));
  const cleanRows = valid.filter((v) => !errorRowSet.has(v._row));
  errors.sort((a, b) => a.row - b.row);

  const job = await db.importJob.create({
    data: {
      organizationId: ctx.organizationId,
      type: "subscribers",
      fileName: input.fileName,
      totalRows: parsed.rows.length,
      validRows: cleanRows.length,
      errorRows: errorRowSet.size,
      errors: errors.slice(0, 1000) as unknown as Prisma.InputJsonValue,
      normalizedRows: cleanRows as unknown as Prisma.InputJsonValue,
      createdById: ctx.kind === "staff" ? ctx.userId : null,
    },
  });
  await audit(ctx, { action: "import.preview", entityType: "import_job", entityId: job.id, metadata: { fileName: input.fileName, totalRows: job.totalRows, errorRows: job.errorRows } });

  return {
    jobId: job.id,
    totalRows: job.totalRows,
    validRows: job.validRows,
    errorRows: job.errorRows,
    errors: errors.slice(0, 200),
    unknownColumns: unknown,
    sample: cleanRows.slice(0, 20).map((r) => ({ row: r._row, name: r.type === "BUSINESS" ? r.companyName : [r.firstName, r.lastName].filter(Boolean).join(" "), phone: r.phone, email: r.email, packageId: r.packageId, branchId: r.branchId })),
    canCommit: job.errorRows === 0 && job.validRows > 0,
  };
}

export async function commitSubscriberImport(ctx: ActorContext, jobId: string) {
  requirePermission(ctx, "subscribers.import");
  const job = await db.importJob.findFirst({ where: { id: jobId, organizationId: ctx.organizationId, type: "subscribers" } });
  if (!job) throw notFound("import");
  if (job.status === "COMMITTED") throw new AppError("CONFLICT", "This import has already been committed.");
  if (job.status !== "PREVIEWED") throw new AppError("INVALID_STATE", "This import can no longer be committed. Upload the file again.");
  if (job.errorRows > 0) throw new AppError("INVALID_STATE", "Fix all row errors and upload the file again before committing.");
  if (Date.now() - job.createdAt.getTime() > PREVIEW_TTL_MS) throw new AppError("INVALID_STATE", "This preview has expired. Upload the file again.");
  const rows = (job.normalizedRows ?? []) as unknown as NormalizedRow[];
  const needsSubscriptionPermission = rows.some((r) => r.packageId);
  if (needsSubscriptionPermission) requirePermission(ctx, "subscriptions.write");

  try {
    const created = await db.$transaction(
      async (tx) => {
        await lockRow(tx, "ImportJob", jobId);
        const fresh = await tx.importJob.findUniqueOrThrow({ where: { id: jobId } });
        if (fresh.status !== "PREVIEWED") throw new AppError("CONFLICT", "This import has already been committed.");
        let count = 0;
        for (const { _row, ...row } of rows) {
          try {
            await createSubscriberTx(tx, ctx, row, { source: `import ${job.fileName}` });
          } catch (err) {
            if (isAppError(err)) throw new AppError(err.code, `Row ${_row}: ${err.message}`);
            throw err;
          }
          count++;
        }
        await tx.importJob.update({ where: { id: jobId }, data: { status: "COMMITTED", committedAt: new Date(), normalizedRows: [] } });
        return count;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await audit(ctx, { action: "import.commit", entityType: "import_job", entityId: jobId, metadata: { created } });
    return { created };
  } catch (err) {
    if (!(isAppError(err) && err.code === "CONFLICT" && err.message.startsWith("This import"))) {
      await db.importJob.update({ where: { id: jobId }, data: { status: "FAILED" } }).catch(() => undefined);
      await audit(ctx, { action: "import.failed", entityType: "import_job", entityId: jobId, metadata: { reason: isAppError(err) ? err.message : "unexpected" } });
    }
    throw err;
  }
}

export async function listImportJobs(ctx: ActorContext) {
  requirePermission(ctx, "subscribers.import");
  return db.importJob.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, type: true, status: true, fileName: true, totalRows: true, validRows: true, errorRows: true, createdAt: true, committedAt: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

export const IMPORT_TEMPLATE = `${IMPORT_COLUMNS.join(",")}\nJane,Wanjiku,,individual,0712345678,,jane@example.com,12345678,Kahawa Sukari Rd,Kahawa,Nairobi,Nairobi,,,\n,,Acme Traders Ltd,business,0722000111,,accounts@acme.example,P051234567X,Moi Avenue,CBD,Nairobi,Nairobi,,,Fibre install pending\n`;
