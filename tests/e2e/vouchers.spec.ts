import { expect, test } from "@playwright/test";
import { login, uniq } from "./helpers";
import { E2E_USERS } from "./users";

test("generate vouchers, redeem one on the captive portal, and see honest activation status", async ({ page, browser }) => {
  const id = uniq();
  await login(page, E2E_USERS.owner);
  await page.goto("/packages");
  await page.getByRole("button", { name: "New package" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill(`Hotspot ${id}`);
  await d.getByLabel("Service type").selectOption("HOTSPOT");
  await d.getByLabel(/^Price/).fill("30");
  await d.getByLabel("Billing period").selectOption("HOUR");
  await d.getByLabel("Every").fill("3");
  await d.getByRole("button", { name: "Create package" }).click();
  await expect(d).toBeHidden();

  await page.goto("/vouchers");
  await page.getByRole("button", { name: "Generate batch" }).click();
  const g = page.getByRole("dialog");
  await g.getByLabel("Package").selectOption({ label: `Hotspot ${id} — 3 hours · KES 30.00 + tax` });
  await g.getByLabel("Quantity").fill("3");
  await g.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByRole("dialog").locator("li")).toHaveCount(3);
  const codes = (await page.getByRole("dialog").locator("li").allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(3);
  const pdfHref = await page.getByRole("link", { name: /Printable cards/ }).getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await page.getByRole("button", { name: "Done" }).click();

  // Customer on the hotspot (fresh browser, no staff session)
  const guest = await (await browser.newContext()).newPage();
  await guest.goto("/hotspot/alpha-e2e?mac=AA:BB:CC:DD:EE:42&ip=10.5.50.20");
  await guest.getByLabel("Voucher code").fill(codes[0]!.toLowerCase());
  await guest.getByRole("button", { name: "Connect" }).click();
  await expect(guest.getByText("Voucher accepted (test mode)")).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByText("No real internet session was started")).toBeVisible();

  // Reuse is rejected
  const again = await (await browser.newContext()).newPage();
  await again.goto("/hotspot/alpha-e2e");
  await again.getByLabel("Voucher code").fill(codes[0]!);
  await again.getByRole("button", { name: "Connect" }).click();
  await expect(again.getByRole("alert").filter({ hasText: "already been used" })).toBeVisible();

  // Staff sees the redemption as simulated
  await page.reload();
  await page.getByRole("link", { name: /^VB-\d{5}$/ }).first().click();
  await expect(page.getByText("Simulated").first()).toBeVisible();
  await expect(page.getByText("Redeemed", { exact: true }).first()).toBeVisible();
});
