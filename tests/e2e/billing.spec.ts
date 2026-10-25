import { expect, test, type Page } from "@playwright/test";
import { login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

/** Create a package + subscriber with an active subscription (which issues the activation invoice). */
async function onboard(page: Page, price = "3000") {
  const id = uniq();
  await page.goto("/packages");
  await page.getByRole("button", { name: "New package" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill(`Plan ${id}`);
  await d.getByLabel(/^Price/).fill(price);
  await d.getByRole("button", { name: "Create package" }).click();
  await expect(d).toBeHidden();
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill("Billing");
  await page.getByLabel("Last name").fill(`Case${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(phone());
  await page.getByLabel("Package").selectOption({ label: `Plan ${id} — KES ${Number(price).toFixed(2)}` });
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/created=1/);
  return { id, name: `Billing Case${id}` };
}

test("activation invoice, partial then full manual payment, receipt and paid invoice", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  const { name } = await onboard(page, "3000");

  // Billing card shows the activation invoice and amount owed.
  await expect(page.getByText("Owed (open invoices)")).toBeVisible();
  await expect(page.getByText("KES 3,000.00").first()).toBeVisible();

  // Partial payment
  await page.getByRole("link", { name: "Record payment" }).click();
  await expect(page.getByRole("heading", { name: "Record payment" })).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.getByLabel(/^Amount/).fill("1200");
  await page.getByRole("button", { name: /^Record KES 1,200.00/ }).click();
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}\?recorded=1/);
  await expect(page.getByText(/Payment recorded · receipt RCT-\d{6}/)).toBeVisible();

  // Receipt PDF is served from persisted data
  const receiptHref = await page.getByRole("link", { name: "Receipt PDF" }).getAttribute("href");
  const pdf = await page.request.get(receiptHref!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  // Invoice now partially paid with the right balance
  await page.getByRole("link", { name: /^[A-Z]{2,6}-\d{6}$/ }).first().click();
  await expect(page.getByText("Part paid").or(page.getByText("Partially paid"))).toBeVisible();
  await expect(page.getByText("KES 1,800.00").first()).toBeVisible();

  // Pay the rest from the invoice page
  await page.getByRole("link", { name: "Record payment" }).click();
  await page.getByLabel(/^Amount/).fill("1800");
  await page.getByLabel("Method").selectOption("MPESA");
  await page.getByLabel("Reference").fill(`QA${Date.now().toString(36).toUpperCase()}`);
  await page.getByRole("button", { name: /^Record KES 1,800.00/ }).click();
  await expect(page).toHaveURL(/recorded=1/);
  await page.getByRole("link", { name: /^[A-Z]{2,6}-\d{6}$/ }).first().click();
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  const invoicePdf = await page.request.get(page.url().replace("/invoices/", "/api/v1/invoices/") + "/pdf");
  expect(invoicePdf.status()).toBe(200);
});

test("accountant matches an unidentified bank receipt to a subscriber", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  const { id, name } = await onboard(page, "2000");
  await page.goto("/payments/new");
  await page.getByLabel(/Payer not identified/).check();
  await page.getByLabel("Payer name (as on the bank statement)").fill(`B CASE ${id}`);
  await page.getByLabel(/^Amount/).fill("2000");
  await page.getByLabel("Method").selectOption("BANK_TRANSFER");
  await page.getByLabel("Reference").fill(`FT${Date.now().toString(36).toUpperCase()}`);
  await page.getByRole("button", { name: /^Record KES 2,000.00/ }).click();
  await expect(page.getByText("Unmatched payment")).toBeVisible();
  const paymentUrl = page.url().split("?")[0]!;

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await login(page, E2E_USERS.accountant);
  await page.goto("/reconciliation");
  await expect(page.getByText(`B CASE ${id}`)).toBeVisible();
  await page.goto(paymentUrl);
  await page.getByRole("button", { name: "Match to subscriber" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill(`Case${id}`);
  await dialog.getByRole("option", { name: new RegExp(name) }).click();
  await dialog.getByRole("button", { name: "Match payment" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(page.getByRole("cell", { name: /[A-Z]{2,6}-\d{6}/ })).toBeVisible(); // auto-allocated

  await page.goto("/reconciliation");
  await page.getByRole("button", { name: "Run balance checks" }).click();
  await expect(page.getByText("All checks passed")).toBeVisible();
});

test("cashier cannot refund or reverse payments (UI and API)", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await onboard(page, "1000");
  await page.getByRole("link", { name: "Record payment" }).click();
  await page.getByLabel(/^Amount/).fill("1500"); // 500 overpayment becomes credit
  await page.getByRole("button", { name: /^Record KES 1,500.00/ }).click();
  await expect(page).toHaveURL(/recorded=1/);
  const paymentUrl = page.url().split("?")[0]!;
  const paymentId = paymentUrl.split("/").pop()!;
  await expect(page.getByRole("button", { name: "Refund" })).toBeVisible(); // owner can

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await login(page, E2E_USERS.cashier);
  // The cashier is restricted to the East branch; the payment belongs to no branch, so it is not even visible.
  await page.goto(paymentUrl);
  await expect(page.getByRole("button", { name: "Refund" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reverse payment" })).toHaveCount(0);
  const res = await page.request.post(`/api/v1/payments/${paymentId}/refunds`, {
    headers: { "idempotency-key": `e2e-refund-${Date.now()}`, origin: new URL(page.url()).origin },
    data: { amount: "100", method: "CASH", reason: "not allowed" },
  });
  expect(res.status()).toBe(403);
});
