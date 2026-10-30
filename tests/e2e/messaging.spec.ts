import { expect, test } from "@playwright/test";
import { createPlan, login, phone, uniq } from "./helpers";
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

test("write a service notice, preview its audience, send it, and set up operator alerts", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  const id = uniq();
  const name = `Outage ${id}`;
  await createPlan(page, { name: `Notice ${id}`, type: "PPPoE", price: "1500", rate: "5M/5M" });
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill("Mumbi");
  await page.getByLabel("Last name").fill(`Notice${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(phone());
  await page.getByLabel("Package").selectOption({ label: `Notice ${id} — KES 1500.00` });
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/created=1/);

  await page.goto("/notifications?tab=campaigns");
  await page.getByRole("button", { name: "New campaign" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel(/^Name/).fill(name);
  await d.getByLabel(/^Message/).fill("Hi {{name}}, there is a fibre cut in your area. Engineers are on site.");
  await d.getByLabel("Subscription").selectOption("ACTIVE");
  await d.getByRole("button", { name: "Preview audience" }).click();
  await expect(d.getByText(/would receive it/)).toBeVisible();
  await expect(d.getByText(/Sample for /)).toBeVisible();
  await d.getByRole("button", { name: "Save draft" }).click();
  await expect(d).toBeHidden();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByText("Draft")).toBeVisible();
  await expect(row.getByText("active subscription")).toBeVisible();
  await row.getByRole("button", { name: "Send" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send now" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: name }).getByText("Sent", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  await page.goto("/settings?tab=alerts");
  await page.getByRole("button", { name: "Add recipient" }).click();
  await page.getByLabel("Recipient 1 phone").fill("0712 000 999");
  await page.getByLabel("A router stops answering health checks").check();
  await page.getByRole("button", { name: "Save operator alerts" }).click();
  await expect(page.getByText("Operator alerts saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Recipient 1 phone")).toHaveValue("254712000999");
});
