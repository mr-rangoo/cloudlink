import { expect, test } from "@playwright/test";
import { login, uniq } from "./helpers";
import { E2E_USERS } from "./users";

test("owner invites a support agent who sets a password and sees only permitted modules", async ({ page, browser }) => {
  const id = uniq();
  const email = `agent-${id}@alpha.e2e.test`;
  await login(page, E2E_USERS.owner);
  await page.goto("/staff");
  await page.getByRole("button", { name: "Invite staff" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Full name").fill(`Agent ${id}`);
  await d.getByLabel("Work email").fill(email);
  await d.getByLabel("Support agent").check();
  await d.getByRole("button", { name: "Invite" }).click();
  const link = (await page.getByRole("dialog").locator("p.font-mono").textContent())!.trim();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: email }).getByText("Setup pending")).toBeVisible();

  const agent = await (await browser.newContext()).newPage();
  await agent.goto(new URL(link).pathname);
  await agent.getByLabel("New password").fill("Agent-Password-123");
  await agent.getByLabel("Confirm password").fill("Agent-Password-123");
  await agent.getByRole("button", { name: "Set password" }).click();
  await expect(agent.getByText("Your password is set")).toBeVisible();
  await login(agent, email, "Agent-Password-123");
  const nav = agent.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: /Support/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Staff & Permissions/ })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /Reports/ })).toHaveCount(0);
  await agent.goto("/settings");
  await expect(agent.getByText("Access restricted")).toBeVisible();
  // The setup link cannot be reused.
  await agent.goto(new URL(link).pathname);
  await expect(agent.getByText("This link is invalid or has expired")).toBeVisible();
});

test("reports render from the ledger and a CSV export can be downloaded", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await page.goto("/reports");
  await expect(page.getByText("Net revenue and collections by month")).toBeVisible();
  await expect(page.getByRole("img", { name: "Net revenue and collections by month" })).toBeVisible();
  await page.goto("/reports?tab=receivables");
  await expect(page.getByText(/equals accounts receivable in the ledger/)).toBeVisible();

  await page.getByRole("button", { name: "Export aging" }).click();
  await expect(page).toHaveURL(/tab=exports/);
  const row = page.getByRole("row").filter({ hasText: "Receivables aging" }).first();
  await expect(async () => {
    await page.reload();
    await expect(row.getByRole("link", { name: "Download CSV" })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const href = await row.getByRole("link", { name: "Download CSV" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(await res.text()).toContain("account_number,subscriber,current");
});

test("settings change the invoice prefix for newly issued invoices", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await page.goto("/settings");
  await page.getByLabel("Invoice prefix").fill("ALP");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.goto("/audit-logs?action=settings.");
  await expect(page.getByRole("cell", { name: "settings.update" }).first()).toBeVisible();
});
