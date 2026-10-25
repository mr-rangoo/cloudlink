import "dotenv/config";
import { execSync } from "node:child_process";

/** Prepare the isolated e2e database: apply migrations, reset data, and load deterministic fixtures. */
export default function globalSetup() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is not set.");
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) throw new Error(`Refusing to prepare "${dbName}": e2e database name must end with _e2e.`);
  const env = { ...process.env, DATABASE_URL: url, APP_ENV: "test" };
  execSync("npx prisma migrate deploy", { stdio: "inherit", env });
  execSync("npx tsx --conditions=react-server tests/e2e/seed-e2e.ts", { stdio: "inherit", env });
}
