import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3101);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: [
    {
      command: `npx next start -p ${port}`,
      url: `${baseURL}/api/v1/health/live`,
      reuseExistingServer: false,
      timeout: 120000,
      env: { E2E: "1", APP_URL: baseURL, APP_ENV: "test", DATABASE_URL: process.env.E2E_DATABASE_URL ?? "", REDIS_URL: "", NETWORK_ADAPTER: "mock", PAYMENT_ADAPTER: "mock", ENABLE_DEMO_SEED: "false" },
    },
    {
      // The real background worker (database-polling mode) so queued jobs and notifications are processed.
      command: "npx tsx --conditions=react-server src/worker/index.ts",
      url: "http://127.0.0.1:3199/health/live",
      reuseExistingServer: false,
      timeout: 120000,
      env: { APP_URL: baseURL, APP_ENV: "test", DATABASE_URL: process.env.E2E_DATABASE_URL ?? "", REDIS_URL: "", WORKER_HEALTH_PORT: "3199", WORKER_SWEEP_INTERVAL_MS: "1000", OPERATION_BACKOFF_BASE_MS: "1500", NETWORK_ADAPTER: "mock", PAYMENT_ADAPTER: "mock", ENABLE_DEMO_SEED: "false" },
    },
  ],
});
