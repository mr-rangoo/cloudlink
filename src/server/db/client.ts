import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Single PrismaClient per process. In development, Next.js hot reload would otherwise
 * create a new pool on every edit, so the instance is cached on globalThis.
 */
const globalForPrisma = globalThis as unknown as { __cloudlinkPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  // Pin every session to UTC. The driver adapter sends timestamps without an offset, so a server
  // whose default timezone is e.g. Africa/Nairobi would otherwise shift stored instants by +3h and
  // disagree with SQL now(). Business-calendar logic converts to the organization timezone explicitly.
  const adapter = new PrismaPg({ connectionString, max: Number(process.env.DATABASE_POOL_MAX ?? 10), options: "-c timezone=UTC" });
  return new PrismaClient({ adapter });
}

export function getDb(): PrismaClient {
  if (!globalForPrisma.__cloudlinkPrisma) globalForPrisma.__cloudlinkPrisma = createClient();
  return globalForPrisma.__cloudlinkPrisma;
}

/** Lazy proxy so modules can `import { db }` without connecting at import time (important for `next build`). */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getDb();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export async function disconnectDb(): Promise<void> {
  if (globalForPrisma.__cloudlinkPrisma) {
    await globalForPrisma.__cloudlinkPrisma.$disconnect();
    globalForPrisma.__cloudlinkPrisma = undefined;
  }
}
