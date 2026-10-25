import { expect, test, type Page } from "@playwright/test";
import { login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

const PORTAL_PASSWORD = "Customer-Pass-123";

/** Staff creates a package + subscriber (activation invoice issued) and a portal setup link. */
async function subscriberWithPortal(page: Page, label: string) {
  const id = uniq();
  const tel = phone();
  await page.goto("/packages");
  await page.getByRole("button", { name: "New package" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill(`Portal ${label} ${id}`);
  await d.getByLabel(/^Price/).fill("1800");
  await d.getByRole("button", { name: "Create package" }).click();
  await expect(d).toBeHidden();
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill(label);
  await page.getByLabel("Last name").fill(`Portal${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(tel);
  await page.getByLabel("Package").selectOption({ label: `Portal ${label} ${id} — KES 1800.00` });
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/created=1/);
  const subscriberUrl = page.url().split("?")[0]!;

  await page.getByRole("button", { name: "Create setup link" }).click();
  const linkText = await page.getByRole("dialog").locator("p.font-mono").textContent();
  await page.getByRole("button", { name: "Done" }).click();
  const invoiceLink = page.getByRole("link", { name: /^[A-Z]{2,6}-\d{6}$/ }).first();
  const invoiceHref = await invoiceLink.getAttribute("href");
  return { tel, link: linkText!.trim(), invoiceId: invoiceHref!.split("/").pop()!, subscriberUrl, name: `${label} Portal${id}` };
}

test("customer activates, signs in, sees only their own invoice, and raises a support request", async ({ page, browser }) => {
  await login(page, E2E_USERS.owner);
  const a = await subscriberWithPortal(page, "Amani");
  const b = await subscriberWithPortal(page, "Baraka");

  // Customer A in a separate browser context (no staff cookies).
  const customer = await (await browser.newContext()).newPage();
  const link = new URL(a.link);
  await customer.goto(link.pathname + link.search);
  await customer.getByLabel("New password").fill(PORTAL_PASSWORD);
  await customer.getByLabel("Confirm password").fill(PORTAL_PASSWORD);
  await customer.getByRole("button", { name: "Save password" }).click();
  await expect(customer.getByText("Your password is set")).toBeVisible();
  await customer.getByLabel("Phone or account number").fill(a.tel);
  await customer.getByLabel("Password").fill(PORTAL_PASSWORD);
  await customer.getByRole("button", { name: "Sign in" }).click();
  await expect(customer).toHaveURL(/\/portal\/home/);
  await expect(customer.getByText("Amount due")).toBeVisible();
  await expect(customer.getByText("KES 1,800.00").first()).toBeVisible();

  // Own invoice visible, with PDF
  await customer.goto(`/portal/invoices/${a.invoiceId}`);
  await expect(customer.getByRole("heading", { name: /Invoice [A-Z]{2,6}-\d{6}/ })).toBeVisible();
  const pdf = await customer.request.get(`/api/v1/customer/invoices/${a.invoiceId}/pdf`);
  expect(pdf.status()).toBe(200);

  // Another customer's invoice: page 404 and API 404
  const other = await customer.goto(`/portal/invoices/${b.invoiceId}`);
  expect(other?.status()).toBe(404);
  const api = await customer.request.get(`/api/v1/customer/invoices/${b.invoiceId}`);
  expect(api.status()).toBe(404);
  // Staff API is not reachable with a customer session
  expect((await customer.request.get("/api/v1/invoices")).status()).toBe(401);

  // Support request
  await customer.goto("/portal/tickets/new");
  await customer.getByLabel("Subject").fill("Connection drops at night");
  await customer.getByLabel("Describe the problem").fill("Since Monday the router loses connection around 9pm.");
  await customer.getByRole("button", { name: "Send request" }).click();
  await expect(customer.getByRole("heading", { name: "Connection drops at night" })).toBeVisible();
  const ticketNumber = (await customer.getByText(/TKT-\d{6}/).first().textContent())!.match(/TKT-\d{6}/)![0];

  // Staff replies (with an internal note the customer must not see)
  await page.goto(`/support?q=${ticketNumber}`);
  await page.getByRole("link", { name: ticketNumber }).click();
  await page.getByLabel("Reply to customer").fill("We have scheduled a line check for tomorrow morning.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("We have scheduled a line check")).toBeVisible();
  await page.getByLabel(/Internal note/).check();
  await page.getByLabel("Internal note (staff only)").fill("Suspect faulty splitter at the pole");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Suspect faulty splitter")).toBeVisible();

  await customer.reload();
  await expect(customer.getByText("We have scheduled a line check")).toBeVisible();
  await expect(customer.getByText("Suspect faulty splitter")).toHaveCount(0);
  await expect(customer.getByText("In progress")).toBeVisible();

  // Notification is delivered by the background worker through the mock adapter (marked simulated)
  await page.goto("/notifications");
  await expect(page.getByText("ticket.reply").first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("simulated (mock)").first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});

test("portal sign-in failures are generic and the staff area is not reachable", async ({ page }) => {
  await page.goto("/portal/alpha-e2e/login");
  await page.getByLabel("Phone or account number").fill("0700000000");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "details you entered are incorrect" })).toBeVisible();
  await page.goto("/portal/home");
  await expect(page).toHaveURL(/\/portal\/alpha-e2e\/login|\/portal$/);
});
