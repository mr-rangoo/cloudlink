import { expect, test } from "@playwright/test";
import { createPlan, login, phone, uniq } from "./helpers";
import { E2E_USERS } from "./users";

test("create package, create subscriber with an active subscription, then suspend and reactivate", async ({ page }) => {
  const id = uniq();
  await login(page, E2E_USERS.owner);

  // Create package
  await createPlan(page, { name: `Home ${id}`, type: "PPPoE", price: "2500", rate: "5M/10M" });
  await page.goto("/packages");
  const row = page.getByRole("row").filter({ hasText: `Home ${id}` });
  await expect(row).toBeVisible();
  await expect(row.getByText("KES 2,500.00")).toBeVisible();
  await expect(row.getByText("5M/10M")).toBeVisible();

  // Create subscriber with that package
  await page.goto("/subscribers/new");
  await page.getByLabel("First name").fill("Esther");
  await page.getByLabel("Last name").fill(`Test${id}`);
  await page.getByLabel("Phone (M-Pesa)").fill(phone());
  await page.getByLabel("Package").selectOption({ label: `Home ${id} — KES 2500.00` });
  await page.getByRole("button", { name: "Create subscriber" }).click();

  await expect(page).toHaveURL(/\/subscribers\/[0-9a-f-]{36}\?created=1/);
  await expect(page.getByRole("heading", { name: `Esther Test${id}` })).toBeVisible();
  await expect(page.getByText(/Subscriber A\d{6} created/)).toBeVisible();
  const subRow = page.getByRole("listitem").filter({ hasText: `Home ${id}` });
  await expect(subRow.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Not provisioned", { exact: true })).toBeVisible(); // network status is honest

  // Suspend (reason required) then reactivate
  await subRow.getByRole("button", { name: "Suspend" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByRole("dialog").getByText(/reason/i).first()).toBeVisible();
  await page.getByRole("dialog").getByLabel("Reason").fill("Customer travelling");
  await page.getByRole("dialog").getByRole("button", { name: "Suspend" }).click();
  await expect(subRow.getByText("Suspended", { exact: true })).toBeVisible();

  await subRow.getByRole("button", { name: "Reactivate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reactivate" }).click();
  await expect(subRow.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText(/subscription suspended: Customer travelling/)).toBeVisible();

  // Appears in the subscribers list search
  await page.goto(`/subscribers?q=Test${id}`);
  await expect(page.getByRole("link", { name: `Esther Test${id}` })).toBeVisible();
});

test("duplicate phone numbers are flagged before creating a second account", async ({ page }) => {
  const id = uniq();
  const tel = phone();
  await login(page, E2E_USERS.owner);
  for (const name of ["First", "Second"]) {
    await page.goto("/subscribers/new");
    await page.getByLabel("First name").fill(`${name}${id}`);
    await page.getByLabel("Phone (M-Pesa)").fill(tel);
    await page.getByRole("button", { name: "Create subscriber" }).click();
    if (name === "First") await expect(page).toHaveURL(/created=1/);
  }
  await expect(page.getByText("Possible duplicate")).toBeVisible();
  await page.getByLabel(/different customer/).check();
  await page.getByRole("button", { name: "Create subscriber" }).click();
  await expect(page).toHaveURL(/created=1/);
});

test("lead is converted into a subscriber and keeps its history", async ({ page }) => {
  const id = uniq();
  await login(page, E2E_USERS.owner);
  await page.goto("/leads");
  await page.getByRole("button", { name: "New lead" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill(`Lead ${id}`);
  await d.getByLabel("Phone").fill(phone());
  await d.getByLabel("Location").fill("Kilimani");
  await d.getByRole("button", { name: "Create lead" }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);

  await page.getByLabel("Interaction type").selectOption("call");
  await page.getByLabel("Details").fill("Wants installation next week");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Wants installation next week")).toBeVisible();
  await expect(page.getByText("Stage changed from NEW to CONTACTED")).toBeVisible();

  await page.getByRole("button", { name: "Convert to subscriber" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Convert" }).click();
  await expect(page).toHaveURL(/\/subscribers\/[0-9a-f-]{36}\?created=1/);
  await expect(page.getByText("Converted from lead", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Converted from lead "Lead/)).toBeVisible(); // timeline entry
  await page.getByRole("link", { name: `Lead ${id}` }).click();
  await expect(page.getByText("This lead became subscriber")).toBeVisible();
  await expect(page.getByText("Wants installation next week")).toBeVisible();
});

test("CSV import previews errors and commits a clean file", async ({ page }) => {
  const id = uniq();
  await login(page, E2E_USERS.owner);
  await page.goto("/subscribers/import");
  const bad = `first_name,phone\nGood${id},${phone()}\nBad${id},123\n`;
  await page.locator('input[type="file"]').setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from(bad) });
  await expect(page.getByText("Enter a valid phone number")).toBeVisible();
  await expect(page.getByText("Commit is disabled while any row has errors")).toBeVisible();

  const good = `first_name,last_name,phone\nImport${id},One,${phone()}\nImport${id},Two,${phone()}\n`;
  await page.locator('input[type="file"]').setInputFiles({ name: "good.csv", mimeType: "text/csv", buffer: Buffer.from(good) });
  await page.getByRole("button", { name: "Import 2 subscribers" }).click();
  await expect(page.getByText("2 subscribers imported")).toBeVisible();
  await page.goto(`/subscribers?q=Import${id}`);
  await expect(page.getByRole("link", { name: `Import${id} One` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Import${id} Two` })).toBeVisible();
});

test("branch-restricted cashier cannot create subscribers or see the import page", async ({ page }) => {
  await login(page, E2E_USERS.cashier);
  await page.goto("/subscribers");
  await expect(page.getByRole("link", { name: "New subscriber" })).toHaveCount(0);
  await page.goto("/subscribers/new");
  await expect(page.getByText("Access restricted")).toBeVisible();
  await page.goto("/subscribers/import");
  await expect(page.getByText("Access restricted")).toBeVisible();
});
