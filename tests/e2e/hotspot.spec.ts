import { expect, test } from "@playwright/test";
import { createPlan, login, uniq } from "./helpers";
import { E2E_USERS } from "./users";

/**
 * PAYMENT_ADAPTER=mock and NETWORK_ADAPTER=mock: no prompt is sent, no money moves and no router changes. The guest plays
 * the M-Pesa response with the test-mode button, which goes through the real callback validation and verification.
 */
test("guest buys a hotspot plan with M-Pesa on the captive portal and reconnects with the M-Pesa code", async ({ page, browser }) => {
  const id = uniq();
  const plan = `Quick hour ${id}`;
  await login(page, E2E_USERS.owner);
  await createPlan(page, { name: plan, type: "Hotspot", price: "10", duration: "1 hour", rate: "5M/5M" });

  const guest = await (await browser.newContext()).newPage();
  await guest.goto("/hotspot/alpha-e2e?mac=AA:BB:CC:DD:EE:51&ip=10.5.50.21");
  await guest.getByRole("button", { name: new RegExp(plan) }).click();
  const phone = `0722${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}7`; // the mock gateway rejects numbers ending in 000
  await guest.getByRole("textbox", { name: "M-Pesa phone number" }).fill(phone);
  await guest.getByRole("button", { name: /^Pay KES 10 with M-Pesa$/ }).click();
  await expect(guest.getByText("Check your phone")).toBeVisible();
  await expect(guest.getByText("Test mode: no prompt was sent and no money moves.")).toBeVisible();
  await guest.getByRole("button", { name: "Simulate payment" }).click();
  await expect(guest.getByText("Plan active (test mode)")).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByText(plan)).toBeVisible();

  // Staff see the M-Pesa payment and the new hotspot customer's active subscription.
  await page.goto("/payments");
  const row = page.getByRole("row").filter({ hasText: "KES 10.00" }).filter({ hasText: /SIM[0-9A-F]{7}/ }).first();
  await expect(row).toBeVisible();
  const receipt = (await row.getByText(/^SIM[0-9A-F]{7}$/).textContent())!.trim();

  // Another device: "Already paid?" with the M-Pesa code and the paying phone.
  const other = await (await browser.newContext()).newPage();
  await other.goto("/hotspot/alpha-e2e");
  await other.getByRole("button", { name: "Already paid?" }).click();
  await other.getByRole("textbox", { name: "M-Pesa phone number" }).fill(phone);
  await other.getByRole("textbox", { name: "M-Pesa confirmation code" }).fill(receipt.toLowerCase());
  await other.getByRole("button", { name: "Reconnect" }).click();
  await expect(other.getByText("Plan active (test mode)")).toBeVisible({ timeout: 30_000 });

  // A wrong code is refused without saying which part was wrong.
  const wrong = await (await browser.newContext()).newPage();
  await wrong.goto("/hotspot/alpha-e2e");
  await wrong.getByRole("button", { name: "Already paid?" }).click();
  await wrong.getByRole("textbox", { name: "M-Pesa phone number" }).fill(phone);
  await wrong.getByRole("textbox", { name: "M-Pesa confirmation code" }).fill("WRONG12345");
  await wrong.getByRole("button", { name: "Reconnect" }).click();
  await expect(wrong.getByRole("alert").filter({ hasText: "could not find an active plan" })).toBeVisible();
});
