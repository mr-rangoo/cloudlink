import { expect, test, type Page } from "@playwright/test";
import { createPlan, login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

/**
 * Network flows run with NETWORK_ADAPTER=mock (no device): results are labelled simulated, and routers whose name
 * contains "[flaky]" time out on the first attempt of every operation, so the retry policy is observable.
 */

async function onboardPppoe(page: Page) {
  const id = uniq();
  await createPlan(page, { name: `Fibre ${id}`, type: "PPPoE", price: "2500", profile: "fibre-10m" });
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill("Net");
  await page.getByLabel("Last name").fill(`Case${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(phone());
  await page.getByLabel("Package").selectOption({ label: `Fibre ${id} — KES 2500.00` });
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/created=1/);
  return { id, subscriberUrl: page.url().split("?")[0]! };
}

async function registerRouter(page: Page, name: string, host: string) {
  await page.goto("/routers");
  await page.getByRole("button", { name: "Add router" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel(/^Name/).fill(name);
  await d.getByLabel("Management IP (private or VPN)").fill(host);
  await d.getByLabel("API username").fill("cloudlink-api");
  await d.getByLabel("API password").fill("not-a-real-password");
  await d.getByRole("button", { name: "Register router" }).click();
  await expect(d).toBeHidden();
  await expect(page.getByRole("link", { name })).toBeVisible();
}

test("router mock failure is visible and retried according to policy", async ({ page }) => {
  await login(page, E2E_USERS.owner);

  // Public addresses are refused for router management.
  await page.goto("/routers");
  await page.getByRole("button", { name: "Add router" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel(/^Name/).fill("Public attempt");
  await d.getByLabel("Management IP (private or VPN)").fill("41.90.10.10");
  await d.getByLabel("API username").fill("x");
  await d.getByLabel("API password").fill("y");
  await d.getByRole("button", { name: "Register router" }).click();
  await expect(d.getByText(/private network or VPN address/)).toBeVisible();
  await d.getByRole("button", { name: "Cancel" }).click();

  const routerName = `Lab [flaky] ${uniq()}`;
  await registerRouter(page, routerName, "10.0.0.7");
  await expect(page.getByText("Mock network adapter")).toBeVisible();

  const { subscriberUrl } = await onboardPppoe(page);
  await page.getByRole("button", { name: "Provision PPPoE" }).click();
  const p = page.getByRole("dialog");
  await p.getByLabel("Router").selectOption({ label: `${routerName} (10.0.0.7)` });
  await p.getByRole("button", { name: "Provision" }).click();
  await expect(p).toBeHidden();

  // Open the operation from the subscriber's network card and watch the worker retry it.
  await page.getByRole("link", { name: "Enable PPPoE access" }).click();
  await expect(page.getByRole("heading", { name: "Enable PPPoE access" })).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("ROUTER_TIMEOUT")).toBeVisible({ timeout: 1000 });
    await expect(page.getByText("Failed, will retry")).toBeVisible({ timeout: 1000 });
    await expect(page.getByRole("cell", { name: "Simulated", exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText("This result came from the mock adapter")).toBeVisible();
  await expect(page.getByText("2 of 5")).toBeVisible();

  // The subscriber shows the simulated network state, separate from the billing status.
  await page.goto(subscriberUrl);
  await expect(page.getByText("Enabled (simulated)")).toBeVisible();

  // Operations list shows it with both attempts.
  await page.goto("/sessions?tab=operations");
  await expect(page.getByRole("link", { name: "Enable PPPoE access" }).first()).toBeVisible();
  await expect(page.getByText("2/5").first()).toBeVisible();
});

test("unauthorized staff cannot execute a router action (UI and API)", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  const origin = new URL(page.url()).origin;
  const created = await page.request.post("/api/v1/routers", {
    headers: { origin },
    data: { name: `Edge ${uniq()}`, host: "10.0.0.8", username: "cloudlink-api", password: "not-a-real-password" },
  });
  expect(created.status()).toBe(201);
  const routerId = ((await created.json()) as { data: { id: string } }).data.id;

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await login(page, E2E_USERS.cashier);

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: /Routers/ })).toHaveCount(0);
  await page.goto(`/routers/${routerId}`);
  await expect(page.getByText("Access restricted")).toBeVisible();
  await page.goto("/sessions");
  await expect(page.getByText("Access restricted")).toBeVisible();

  const res = await page.request.post(`/api/v1/routers/${routerId}/operations`, {
    headers: { origin },
    data: { type: "session.disconnect", kind: "PPPOE", username: "a000001" },
  });
  expect(res.status()).toBe(403);
  const health = await page.request.post(`/api/v1/routers/${routerId}/health-check`, { headers: { origin } });
  expect(health.status()).toBe(403);
});

test("router page: health check feeds the performance view, diagnosis and reboot run as simulated operations", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  const origin = new URL(page.url()).origin;
  const name = `Tower ${uniq()}`;
  const created = await page.request.post("/api/v1/routers", {
    headers: { origin },
    data: { name, host: "10.0.0.9", username: "cloudlink-api", password: "not-a-real-password", hotspotEnabled: true },
  });
  expect(created.status()).toBe(201);
  const routerId = ((await created.json()) as { data: { id: string } }).data.id;

  await page.goto(`/routers/${routerId}`);
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Good · simulated")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("link", { name: "Performance" }).click();
  await expect(page.getByRole("heading", { name: "CPU and memory" })).toBeVisible();
  await expect(page.getByText(/simulated readings \(mock adapter\)/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Reachability by day and hour" })).toBeVisible();

  await page.getByRole("link", { name: "Diagnostics" }).click();
  await page.getByRole("button", { name: "Run diagnosis" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Taken .* simulated \(mock adapter\)/)).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  // The mock adapter checks nothing, so nothing is reported as passing.
  await expect(page.getByText("· Skipped").first()).toBeVisible();
  await expect(page.getByText("· OK")).toHaveCount(0);

  await page.getByRole("button", { name: "Reboot" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/loses service while it restarts/)).toBeVisible();
  await dialog.getByRole("button", { name: "Reboot now" }).click();
  await expect(dialog).toBeHidden();
  await page.goto(`/routers/${routerId}?tab=activity`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row", { name: /Reboot router.*Simulated/ })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
});
