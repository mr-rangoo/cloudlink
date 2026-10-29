import { expect, test } from "@playwright/test";
import { createPlan, login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

/**
 * PAYMENT_ADAPTER=mock: no prompt is sent and no money moves. The customer's response is simulated by staff and goes
 * through the same callback validation and verification pipeline as a real M-Pesa callback.
 */
test("customer pays an invoice with M-Pesa; the balance changes only after the confirmed callback", async ({ page, browser }) => {
  await login(page, E2E_USERS.owner);
  const id = uniq();
  const tel = phone();
  await createPlan(page, { name: `Pay ${id}`, type: "PPPoE", price: "1800" });
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill("Mpesa");
  await page.getByLabel("Last name").fill(`Payer${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(tel);
  await page.getByLabel("Package").selectOption({ label: `Pay ${id} — KES 1800.00` });
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/created=1/);
  await page.getByRole("button", { name: "Create setup link" }).click();
  const link = new URL((await page.getByRole("dialog").locator("p.font-mono").textContent())!.trim());
  await page.getByRole("button", { name: "Done" }).click();

  const customer = await (await browser.newContext()).newPage();
  await customer.goto(link.pathname + link.search);
  await customer.getByLabel("New password").fill("Customer-Pass-123");
  await customer.getByLabel("Confirm password").fill("Customer-Pass-123");
  await customer.getByRole("button", { name: "Save password" }).click();
  await customer.getByLabel("Phone or account number").fill(tel);
  await customer.getByLabel("Password").fill("Customer-Pass-123");
  await customer.getByRole("button", { name: "Sign in" }).click();
  await expect(customer).toHaveURL(/\/portal\/home/);
  await expect(customer.getByText("Test mode: payments here are simulated")).toBeVisible();
  await expect(customer.getByLabel("Amount (KES)")).toHaveValue("1800");
  await customer.getByRole("button", { name: "Pay with M-Pesa" }).click();
  await expect(customer.getByText("Waiting for the customer (simulated)")).toBeVisible();
  await expect(customer.getByText("Amount due")).toBeVisible(); // nothing changes before confirmation

  // Staff sees the request and simulates the customer paying.
  await page.goto("/payments/requests");
  await page.getByRole("link", { name: /\d{1,2} \w{3} \d{4}/ }).first().click();
  await expect(page.getByText("Simulated request", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Simulate: customer pays" }).click();
  await expect(page.getByText("Paid (simulated)").first()).toBeVisible();
  await page.getByRole("link", { name: /^[A-Z]{2,6}-\d{6}$/ }).first().click();
  await expect(page.getByText("No money moved")).toBeVisible();

  // The customer's page picks up the confirmed result from the server.
  await expect(customer.getByText("Paid (simulated)")).toBeVisible({ timeout: 30_000 });
  await expect(customer.getByText(/M-Pesa receipt SIM/)).toBeVisible();
  await customer.reload();
  await expect(customer.getByText("You are all paid up")).toBeVisible();
});
