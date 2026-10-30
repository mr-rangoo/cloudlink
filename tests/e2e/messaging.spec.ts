import { expect, test } from "@playwright/test";
import { createPlan, login, uniq } from "./helpers";
import { E2E_USERS } from "./users";

test("set up an SMS provider, send a simulated test, and text a voucher code to a customer", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await page.goto("/integrations");
  await expect(page.getByRole("heading", { name: "Messaging providers" })).toBeVisible();
  await expect(page.getByText("Mock messaging")).toBeVisible();

  await page.getByRole("button", { name: /Set up SMS|Change SMS provider/ }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel(/^Username/).fill("cloudlinkisp");
  await d.getByLabel(/^Sender ID/).fill("CLOUDLINK");
  await d.getByLabel(/^API key/).fill("not-a-real-api-key-0001");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(d).toBeHidden();
  await expect(page.getByText(/Saved: Africa's Talking \(cloudlinkisp, sender CLOUDLINK\)/)).toBeVisible();
  await expect(page.getByText("not-a-real-api-key-0001")).toHaveCount(0);

  // In mock mode the test is simulated and cannot be confirmed as received.
  await page.getByRole("button", { name: "Send test SMS" }).click();
  await page.getByRole("dialog").getByLabel("Phone number").fill("0712345678");
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Simulated: the mock adapter did not send anything/)).toBeVisible();
  await expect(page.getByRole("button", { name: "I received the test" })).toHaveCount(0);

  // Voucher by SMS from a batch.
  const id = uniq();
  await createPlan(page, { name: `Voucher ${id}`, type: "Hotspot", price: "20", duration: "1 hour" });
  await page.goto("/vouchers");
  await page.getByRole("button", { name: "Generate batch" }).click();
  const g = page.getByRole("dialog");
  await g.getByLabel("Package").selectOption({ label: `Voucher ${id} — 1 hour · KES 20.00 + tax` });
  await g.getByLabel("Quantity").fill("1");
  await g.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByRole("dialog").locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("row").filter({ hasText: `Voucher ${id}` }).getByRole("link").first().click();
  await page.getByRole("button", { name: "Send by SMS" }).click();
  await page.getByRole("dialog").getByLabel("Customer phone").fill("0712 345 679");
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Voucher SMS queued")).toBeVisible();

  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByText("[voucher code sent - not stored]").first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
});
