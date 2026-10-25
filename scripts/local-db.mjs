#!/usr/bin/env node
// Manages a project-local PostgreSQL cluster in .local/pgdata (development only).
// It never touches any other PostgreSQL server on the machine.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".local", "pgdata");
const logFile = path.join(root, ".local", "postgres.log");
const port = process.env.CLOUDLINK_PG_PORT ?? "5433";

function findBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  if (process.platform === "win32") {
    for (const v of ["18", "17", "16"]) {
      const p = path.win32.join("C:", "Program Files", "PostgreSQL", v, "bin");
      if (existsSync(p)) return p;
    }
  }
  return "";
}

const bin = findBin();
const pgCtl = bin ? path.join(bin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl") : "pg_ctl";
const cmd = process.argv[2] ?? "status";

if (!existsSync(dataDir)) {
  console.error(`No local cluster at ${dataDir}. See docs/LOCAL_SETUP.md to initialise one, or use Docker Compose.`);
  process.exit(1);
}

const run = (args) => {
  try {
    execFileSync(pgCtl, args, { stdio: "inherit" });
  } catch (err) {
    if (err.code === "ENOENT") console.error(`pg_ctl not found at ${pgCtl}. Set PG_BIN to your PostgreSQL bin directory.`);
    process.exitCode = err.status ?? 1;
  }
};

if (cmd === "start") run(["-D", dataDir, "-l", logFile, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w", "start"]);
else if (cmd === "stop") run(["-D", dataDir, "-m", "fast", "stop"]);
else run(["-D", dataDir, "status"]);
