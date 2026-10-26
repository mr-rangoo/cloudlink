#!/usr/bin/env node
// Restore a Cloudlink backup into an EMPTY database, then verify it.
//
//   node scripts/db-restore.mjs --file backups/x.dump --target <postgres-url> [--create] [--compare-with <source-url>]
//
// Safety rules:
// - never restores into a database that already has tables (no overwrite, no drop, no reset);
// - --create only creates the target database when it does not exist yet;
// - the checksum written by db-backup.mjs must match;
// - connection URLs are never printed.
// Verification: Prisma migration history is present, and with --compare-with every table's row count must match.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

/** Prisma-only query parameters are not understood by libpq tools. */
function libpqUrl(raw) {
  const u = new URL(raw);
  for (const k of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout", "statement_cache_size"]) u.searchParams.delete(k);
  return u.toString();
}

function pgTool(name) {
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

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function tableCounts(url) {
  return withClient(url, async (c) => {
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((r) => r.tablename);
    const out = {};
    for (const t of tables) out[t] = Number((await c.query(`SELECT count(*)::bigint AS n FROM "public"."${t.replace(/"/g, '""')}"`)).rows[0].n);
    return out;
  });
}

const file = arg("file");
const targetArg = arg("target");
if (!file || !targetArg) {
  console.error("Usage: node scripts/db-restore.mjs --file <dump> --target <postgres-url> [--create] [--compare-with <source-url>]");
  process.exit(1);
}

const target = libpqUrl(targetArg);

// 1. Checksum
const sumFile = `${file}.sha256`;
if (!existsSync(sumFile)) {
  console.error(`Missing checksum file ${sumFile}.`);
  process.exit(1);
}
const expected = readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
if (expected !== actual) {
  console.error("Checksum mismatch: the backup file is damaged or was changed. Not restoring.");
  process.exit(1);
}

// 2. Target must be new or empty
const targetUrl = new URL(target);
const dbName = targetUrl.pathname.replace(/^\//, "");
if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
  console.error("Target database name must be letters, digits or underscores.");
  process.exit(1);
}
const adminUrl = new URL(target);
adminUrl.pathname = "/postgres";
const exists = await withClient(adminUrl.toString(), async (c) => (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount > 0);
if (!exists) {
  if (!flag("create")) {
    console.error(`Database ${dbName} does not exist. Pass --create to create it.`);
    process.exit(1);
  }
  await withClient(adminUrl.toString(), (c) => c.query(`CREATE DATABASE "${dbName}"`));
  console.log(`Created empty database ${dbName}.`);
} else {
  const tables = await withClient(target, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n);
  if (tables > 0) {
    console.error(`Database ${dbName} already has ${tables} table(s). Restore only into a new or empty database; nothing was changed.`);
    process.exit(1);
  }
}

// 3. Restore
try {
  execFileSync(pgTool("pg_restore"), ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${target}`, file], { stdio: ["ignore", "inherit", "inherit"] });
} catch (err) {
  console.error(err.code === "ENOENT" ? "pg_restore not found. Set PG_BIN to your PostgreSQL bin directory." : `pg_restore failed (exit ${err.status ?? "?"}).`);
  process.exit(1);
}

// 4. Verify
const migrations = await withClient(target, async (c) => (await c.query(`SELECT count(*)::int AS n, max(migration_name) AS latest FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).rows[0]);
const restoredCounts = await tableCounts(target);
const report = { database: dbName, migrationsApplied: migrations.n, latestMigration: migrations.latest, tables: Object.keys(restoredCounts).length, rows: Object.values(restoredCounts).reduce((a, b) => a + b, 0) };
const sourceArg = arg("compare-with");
const source = sourceArg ? libpqUrl(sourceArg) : undefined;
if (source) {
  const sourceCounts = await tableCounts(source);
  const mismatches = Object.keys({ ...sourceCounts, ...restoredCounts }).filter((t) => sourceCounts[t] !== restoredCounts[t]).map((t) => `${t}: source ${sourceCounts[t] ?? "missing"}, restored ${restoredCounts[t] ?? "missing"}`);
  report.comparedTables = Object.keys(sourceCounts).length;
  report.mismatches = mismatches;
  console.log(JSON.stringify(report, null, 2));
  if (mismatches.length) process.exit(2);
} else {
  console.log(JSON.stringify(report, null, 2));
}
