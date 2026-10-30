import { expect, test } from "@playwright/test";
import { createPlan, login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

test("record search, VIP flag and outage compensation from the subscriber pages", async ({ page }) => {
  const id = uniq();
  await login(page, E2E_USERS.owner);
  await expect(page.getByRole("heading", { name: "What's next" })).toBeVisible();

  await createPlan(page, { name: `Care ${id}`, type: "PPPoE", price: "1800", rate: "5M/5M" });
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill("Wanjiru");
  await page.getByLabel("Last name").fill(`Search${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(phone());
  await page.getByLabel("Package").selectOption({ label: `Care ${id} — KES 1800.00` });
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/\/subscribers\/[0-9a-f-]{36}\?created=1/);
  const subscriberUrl = page.url().split("?")[0]!;

  // Ctrl+K finds the record and opens it.
  await page.goto("/dashboard");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(`Search${id}`);
  const hit = page.getByRole("option", { name: new RegExp(`Wanjiru Search${id}`) });
  await expect(hit).toBeVisible();
  await page.getByRole("combobox").press("Enter");
  await expect(page).toHaveURL(subscriberUrl);

  // VIP: set on the subscriber, then filter the list by it.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByLabel(/VIP/).check();
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("VIP subscriber")).toBeVisible();
  await page.goto("/subscribers?vip=1");
  await expect(page.getByRole("link", { name: `Wanjiru Search${id}` })).toBeVisible();

  // Compensation: one free day, recorded in the history.
  await page.goto(subscriberUrl);
  const subRow = page.getByRole("listitem").filter({ hasText: `Care ${id}` });
  const periodBefore = await subRow.getByText(/^Period /).textContent();
  await subRow.getByRole("button", { name: "Compensate" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Fibre cut on Thika Road");
  await dialog.getByRole("button", { name: "Add free time" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/1 day added free \(Fibre cut on Thika Road\)/)).toBeVisible();
  await expect(subRow.getByText(/^Period /)).not.toHaveText(periodBefore ?? "");
});
