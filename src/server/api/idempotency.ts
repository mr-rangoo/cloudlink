import "server-only";
import { db } from "@/server/db/client";
import { AppError, isAppError } from "@/server/errors";
import { sha256 } from "@/server/security/crypto";
import { Prisma } from "@/generated/prisma/client";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Run `fn` at most once per (scope, key). Retries with the same key and the same request body
 * receive the stored response; a different body with the same key is rejected.
 * Business errors (4xx) are stored too, so a retry sees the same outcome. Validation errors and unexpected
 * failures release the key.
 */
export async function withIdempotency(
  scope: string,
  key: string,
  requestFingerprint: string,
  organizationId: string | null,
  fn: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const requestHash = sha256(requestFingerprint);
  try {
    await db.idempotencyRecord.create({ data: { scope, key, requestHash, organizationId, expiresAt: new Date(Date.now() + TTL_MS) } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await db.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
    if (!existing) throw new AppError("CONFLICT", "Please retry the request.");
    if (existing.expiresAt < new Date()) {
      await db.idempotencyRecord.delete({ where: { id: existing.id } });
      return withIdempotency(scope, key, requestFingerprint, organizationId, fn);
    }
    if (existing.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT");
    if (existing.status === "COMPLETED") return { status: existing.responseStatus ?? 200, body: existing.responseBody, replayed: true };
    throw new AppError("CONFLICT", "An identical request is still being processed. Please wait and retry.");
  }

  try {
    const result = await fn();
    await db.idempotencyRecord.update({
      where: { scope_key: { scope, key } },
      data: { status: "COMPLETED", responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue },
    });
    return { ...result, replayed: false };
  } catch (err) {
    // Validation failures never started executing: release the key so a corrected request can reuse it.
    if (isAppError(err) && err.status < 500 && err.code !== "VALIDATION_ERROR") {
      const body = { error: { code: err.code, message: err.message, ...(err.fields?.length ? { fields: err.fields } : {}) } };
      await db.idempotencyRecord.update({ where: { scope_key: { scope, key } }, data: { status: "COMPLETED", responseStatus: err.status, responseBody: body as unknown as Prisma.InputJsonValue } });
    } else {
      await db.idempotencyRecord.delete({ where: { scope_key: { scope, key } } }).catch(() => undefined);
    }
    throw err;
  }
}
