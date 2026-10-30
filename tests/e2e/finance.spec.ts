import { expect, test } from "@playwright/test";
import { login, uniq } from "./helpers";
import { E2E_USERS } from "./users";

test("payments and expenses by period, with CSV export of the filtered view", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  const origin = new URL(page.url()).origin;
  const payer = `Walk-in ${uniq()}`;
  const res = await page.request.post("/api/v1/payments/manual", {
    headers: { origin, "idempotency-key": `e2e-pay-${uniq()}` },
    data: { subscriberId: null, amount: "345", method: "CASH", receivedAt: new Date(Date.now() - 60_000).toISOString(), payerName: payer },
  });
  expect(res.status()).toBe(201);

  await page.goto("/payments?period=today");
  await expect(page.getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  const row = page.getByRole("row").filter({ hasText: payer });
  await expect(row.getByText("Recorded by staff")).toBeVisible();
  await expect(row.getByText("Unmatched")).toBeVisible();
  await expect(page.getByText("Unmatched", { exact: true }).first()).toBeVisible();

  // Custom dates keep the other filters.
  await page.goto("/payments?method=CASH");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
  await page.getByLabel("From", { exact: true }).fill(today);
  await page.getByLabel("To", { exact: true }).fill(today);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/method=CASH/);
  await expect(page).toHaveURL(/period=custom/);
  await expect(page.getByRole("row").filter({ hasText: payer })).toBeVisible();

  await page.getByRole("button", { name: "Export payments" }).click();
  await expect(page).toHaveURL(/\/reports\?tab=exports/);
  await expect(page.getByRole("cell", { name: "Payments", exact: true }).first()).toBeVisible();

  await page.goto("/expenses?period=30d");
  await expect(page.getByText("Spent", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By category" })).toBeVisible();
});
