import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./users";

export async function login(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Unique suffix so tests can re-run against the same e2e database. */
export function uniq(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

/** Create a plan through the full-page plan form; lands on the plan's edit page. */
export async function createPlan(page: Page, plan: { name: string; type?: string; price: string; duration?: string; rate?: string; profile?: string }) {
  await page.goto("/packages/new");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(plan.name);
  if (plan.type) await page.getByRole("combobox", { name: "Type", exact: true }).selectOption({ label: plan.type });
  await page.getByRole("textbox", { name: /^Price/ }).fill(plan.price);
  await page.getByRole("combobox", { name: "Duration", exact: true }).selectOption({ label: plan.duration ?? "1 month" });
  if (plan.rate) await page.getByRole("textbox", { name: "Rate limit", exact: true }).fill(plan.rate);
  if (plan.profile) await page.getByRole("textbox", { name: "Router profile name", exact: true }).fill(plan.profile);
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page).toHaveURL(/\/packages\/[0-9a-f-]{36}$/);
}

/** Random valid Kenyan mobile number in local format. */
export function phone(): string {
  return `07${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}
