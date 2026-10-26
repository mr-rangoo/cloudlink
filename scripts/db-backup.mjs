#!/usr/bin/env node
// Logical backup of a Cloudlink PostgreSQL database (pg_dump custom format) with a SHA-256 checksum.
//
//   node scripts/db-backup.mjs                      # backs up DATABASE_URL into ./backups
//   node scripts/db-backup.mjs --url <postgres-url> --out <dir>
//
// The connection URL is never printed. The dump contains encrypted credentials (routers, M-Pesa); they can only be
// read with the same APP_ENCRYPTION_KEY, which must be backed up separately in your secret manager, never next to
// the dump. Managed databases should also have provider snapshots/point-in-time recovery enabled (docs/OPERATIONS.md).
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Prisma-only query parameters are not understood by libpq tools. */
function libpqUrl(raw) {
  const u = new URL(raw);
  for (const k of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout", "statement_cache_size"]) u.searchParams.delete(k);
  return u.toString();
}

export function pgTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, exe);
  if (process.platform === "win32") {
    for (const v of ["18", "17", "16"]) {
      const p = path.win32.join("C:", "Program Files", "PostgreSQL", v, "bin", exe);
      if (existsSync(p)) return p;
    }
  }
  return exe;
}

const rawUrl = arg("url") ?? process.env.DATABASE_URL;
if (!rawUrl) {
  console.error("Set DATABASE_URL or pass --url.");
  process.exit(1);
}
const url = libpqUrl(rawUrl);
const outDir = path.resolve(arg("out") ?? "backups");
mkdirSync(outDir, { recursive: true });
const dbName = new URL(url).pathname.replace(/^\//, "") || "cloudlink";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(outDir, `${dbName}-${stamp}.dump`);

try {
  execFileSync(pgTool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", "--compress=6", `--file=${file}`, `--dbname=${url}`], { stdio: ["ignore", "inherit", "inherit"] });
} catch (err) {
  console.error(err.code === "ENOENT" ? "pg_dump not found. Set PG_BIN to your PostgreSQL bin directory." : `pg_dump failed (exit ${err.status ?? "?"}).`);
  process.exit(1);
}
const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);
console.log(JSON.stringify({ file, bytes: statSync(file).size, sha256: sha, database: dbName, createdAt: new Date().toISOString() }));
