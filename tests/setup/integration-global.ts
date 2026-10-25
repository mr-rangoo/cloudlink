import { execSync } from "node:child_process";
import { testDatabaseUrl } from "./test-db";

/** Apply migrations to the isolated test database once per run (never resets or drops anything else). */
export default function setup() {
  const url = testDatabaseUrl();
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
