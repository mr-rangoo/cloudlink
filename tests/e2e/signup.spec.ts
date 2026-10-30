import { expect, test } from "@playwright/test";
import { phone, uniq } from "./helpers";

/** Self-service sign-up. The e2e server uses the mock mailer, so the confirmation link is shown on screen (test mode only). */
test("a new ISP signs up from the sign-in page, confirms the email link and lands in its own workspace", async ({ page }) => {
  const id = uniq();
  await page.goto("/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await page.getByLabel("Company or ISP name").fill(`Kilele Net ${id}`);
  await page.getByLabel("Your name").fill("Zawadi Njeri");
  await page.getByLabel("Work email").fill(`zawadi.${id}@example.co.ke`);
  await page.getByLabel("Phone (optional)").fill(phone());
  await page.getByLabel(/^Password( \*)?$/).fill("Kilele-Pass-2026");
  await page.getByLabel("Confirm password").fill("Kilele-Pass-2026");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/accept the terms/i)).toBeVisible(); // terms box is required
  await page.getByLabel(/I am authorised to open this account/).check();
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("Check your email.")).toBeVisible();
  await expect(page.getByText("Test mode: no email was sent")).toBeVisible();
  await page.getByRole("link", { name: "Open the confirmation link" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Zawadi" })).toBeVisible();
  const confirmUrl = page.url();
  await page.getByRole("button", { name: `Create Kilele Net ${id}` }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(`Kilele Net ${id}`).first()).toBeVisible();
  await expect(page.getByText("Get started with Cloudlink")).toBeVisible();

  // The link is single-use.
  await page.goto(confirmUrl);
  await expect(page.getByText("This link is invalid or has expired")).toBeVisible();
});

test("a prospective customer requests a connection and an existing customer asks for a setup link", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/portal/alpha-e2e/login");
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/portal\/alpha-e2e\/signup/);
  await page.getByLabel("Full name").fill(`Baraka Prospect ${uniq()}`);
  await page.getByLabel(/^Phone( \*)?$/).fill(phone());
  await page.getByLabel("Where do you need internet?").fill("Ruaka, Joyland estate, house 12");
  await page.getByRole("button", { name: "Request a connection" }).click();
  await expect(page.getByText(/will call you to arrange your connection/)).toBeVisible();

  await page.getByLabel("Phone or account number").fill("0700 000 001");
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByText(/If that number belongs to a customer account/)).toBeVisible();
});
