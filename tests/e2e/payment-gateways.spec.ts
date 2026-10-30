import { expect, test } from "@playwright/test";
import { login } from "./helpers";
import { E2E_USERS } from "./users";

/** The e2e server runs PAYMENT_ADAPTER=mock: gateways can be set up and chosen, but no provider is contacted. */
test("owner sets up Kopo Kopo and makes it the gateway for online payments", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await page.goto("/integrations");
  const card = page.locator("div", { has: page.getByText("Payment gateways", { exact: true }) }).filter({ hasText: "Kopo Kopo (K2 Connect)" }).last();
  await expect(card.getByText(/Test mode \(PAYMENT_ADAPTER=mock\)/)).toBeVisible();

  await page.getByRole("button", { name: /Set up Kopo Kopo|Edit Kopo Kopo/ }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Till number").fill("k000123");
  await d.getByLabel("Client ID").fill("e2e-client-id-123");
  await d.getByLabel("Client secret").fill("e2e-client-secret-456");
  await d.getByLabel("API key").fill("e2e-api-key-789-signing");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Kopo Kopo settings saved")).toBeVisible();
  await expect(page.getByText("Till K000123 · Sandbox")).toBeVisible();

  const k2Row = page.locator("li", { hasText: "Kopo Kopo (K2 Connect)" });
  if (await k2Row.getByRole("button", { name: "Use for online payments" }).isVisible()) {
    await k2Row.getByRole("button", { name: "Use for online payments" }).click();
    await expect(page.getByText("Kopo Kopo (K2 Connect) now collects online payments")).toBeVisible();
  }
  await expect(k2Row.getByText("Collecting online payments")).toBeVisible();
  // Secrets are never shown back.
  await expect(page.getByText("e2e-api-key-789-signing")).toHaveCount(0);
});
