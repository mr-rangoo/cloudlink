import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USERS } from "./users";

async function login(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("redirects anonymous visitors to the login page", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("rejects invalid credentials with a generic message", async ({ page }) => {
  await login(page, E2E_USERS.owner, "wrong-password");
  // Filter by text: Next.js renders its own (empty) route-announcer element with role="alert".
  await expect(page.getByRole("alert").filter({ hasText: "email or password is incorrect" })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("staff login and logout", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening), Olive$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Organization: Alpha Net/ })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("navigation is permission-aware and unbuilt modules say so", async ({ page }) => {
  await login(page, E2E_USERS.cashier);
  await expect(page).toHaveURL(/\/dashboard/);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: /Payments/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Staff & Permissions/ })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /Routers/ })).toHaveCount(0);

  // Direct URL to a module the cashier lacks permission for is refused server-side.
  await page.goto("/audit-logs");
  await expect(page.getByText("Access restricted")).toBeVisible();

  await page.goto("/vouchers");
  await expect(page.getByText("Access restricted").or(page.getByText("Vouchers is not yet available"))).toBeVisible();
  await page.goto("/payments");
  await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
});

test("the command menu opens with Ctrl+K and navigates", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("invoices");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/invoices/);
});
