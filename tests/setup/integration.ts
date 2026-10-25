import { afterAll, beforeEach } from "vitest";
import { testDatabaseUrl } from "./test-db";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.APP_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.APP_URL = "http://localhost:3100";
process.env.REDIS_URL = ""; // integration tests exercise the database path; BullMQ dispatch is covered separately
process.env.AUTH_SECRET ??= "integration-test-auth-secret-that-is-long-enough";
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

const { db, disconnectDb } = await import("@/server/db/client");

/** Truncate every application table (test database only) so each test starts clean. */
export async function resetDatabase() {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectDb();
});
