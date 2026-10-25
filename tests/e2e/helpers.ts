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

/** Random valid Kenyan mobile number in local format. */
export function phone(): string {
  return `07${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}
