import { expect, test } from "@playwright/test";
import { login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

/**
 * Portal AI assistant in test mode (ASSISTANT_ADAPTER=mock): replies come from built-in rules, but every fact is
 * looked up through the same customer-scoped tools the Claude adapter uses.
 */
test("staff enable the assistant; a customer asks about their balance and gets a ticket opened", async ({ page, browser }) => {
  await login(page, E2E_USERS.owner);
  const origin = new URL(page.url()).origin;

  await page.goto("/settings?tab=assistant");
  await expect(page.getByText("Test mode", { exact: true })).toBeVisible();
  const toggle = page.getByLabel(/Show the assistant to customers/);
  if (!(await toggle.isChecked())) await toggle.check();
  await page.getByLabel("Assistant name").fill("Nuru");
  await page.getByRole("button", { name: "Save assistant settings" }).click();
  await expect(page.getByText("Assistant settings saved")).toBeVisible();

  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(`/api/v1${path}`, { headers: { origin }, data });
    expect(r.ok(), `${path} ${r.status()}`).toBe(true);
    return ((await r.json()) as { data: Record<string, unknown> }).data;
  };
  const id = uniq();
  const tel = phone();
  const pkg = await post("/packages", { name: `Chat ${id}`, serviceType: "PPPOE", price: "1900.00", billingUnit: "MONTH", billingCount: 1 });
  const created = (await post("/subscribers", { firstName: "Imani", lastName: `Chat${id}`, phone: tel, packageId: pkg.id, activateSubscription: true })) as { subscriber: { id: string } };
  const { link } = (await post(`/subscribers/${created.subscriber.id}/portal`, { action: "link" })) as { link: string };

  const customer = await (await browser.newContext()).newPage();
  const url = new URL(link);
  await customer.goto(url.pathname + url.search);
  await customer.getByLabel("New password").fill("Customer-Pass-123");
  await customer.getByLabel("Confirm password").fill("Customer-Pass-123");
  await customer.getByRole("button", { name: "Save password" }).click();
  await customer.getByLabel("Phone or account number").fill(tel);
  await customer.getByLabel("Password").fill("Customer-Pass-123");
  await customer.getByRole("button", { name: "Sign in" }).click();
  await expect(customer).toHaveURL(/\/portal\/home/);

  await customer.getByRole("link", { name: /Chat with Nuru/ }).click();
  await expect(customer.getByText(/Nuru is an AI assistant/)).toBeVisible();
  await customer.getByRole("button", { name: "What is my balance?" }).click();
  await expect(customer.getByText("Your balance due is KES 1,900.00.", { exact: false })).toBeVisible();
  await expect(customer.getByText("Checked your account")).toBeVisible();

  const box = customer.getByLabel("Message Nuru");
  await box.fill("No internet since morning, please send a technician");
  await box.press("Enter");
  await expect(customer.getByText(/I've opened ticket TKT-\d{6}/)).toBeVisible();
  await customer.getByRole("link", { name: "View ticket" }).click();
  await expect(customer.getByText(/Opened by Nuru \(AI assistant\)/)).toBeVisible();

  // Staff see the chat with the lookups it made.
  await page.goto("/support/assistant");
  await page.getByRole("link", { name: new RegExp(`Imani Chat${id}`) }).click();
  await expect(page.getByText("Looked up:").first()).toBeVisible();
  await expect(page.getByText("Account summary")).toBeVisible();
});
