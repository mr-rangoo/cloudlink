import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { login, uniq } from "./helpers";
import { E2E_USERS } from "./users";

/**
 * Devices: link a MikroTik in four steps, and the TR-069 page. Runs in test mode (mock network and TR-069 adapters):
 * the router is simulated from the wizard and every reading it produces is labelled as simulated.
 */
test("link a MikroTik: name, setup command, services and ports, done", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await page.goto("/routers");
  await expect(page.getByRole("heading", { name: /Your routers/ })).toBeVisible();
  await page.getByRole("link", { name: "Link MikroTik" }).first().click();
  await expect(page).toHaveURL(/\/routers\/link$/);

  // 1. Identity
  const name = `Tower ${uniq()}`;
  await page.getByLabel(/^Router name/).fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/routers\/[0-9a-f-]{36}\/setup/);

  // 2. Provision: Cloudlink's own one-time command, then the (simulated) router checks in.
  const command = page.getByLabel("Setup command", { exact: true });
  await expect(command).toContainText(/^\/tool fetch mode=http url="http:\/\/127\.0\.0\.1:\d+\/api\/v1\/routers\/setup\/[A-Za-z0-9_-]{40,}" dst-path=cloudlink-setup\.rsc; :delay 2s; \/import file-name=cloudlink-setup\.rsc;$/);
  await expect(page.getByText("Waiting for the router to run the command…")).toBeVisible();
  await page.getByRole("button", { name: "Simulate the router" }).click();
  await expect(page.getByText("Router linked (simulated)")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. Services: hotspot on ether2 and the Wi-Fi, PPPoE on ether5, sharing blocked.
  await expect(page.getByRole("heading", { name: "Services to offer" })).toBeVisible();
  await page.getByRole("checkbox", { name: /^PPPoE/ }).check();
  await expect(page.getByLabel("Internet (WAN) port")).toHaveValue("ether1");
  await page.getByLabel("Use of ether2").selectOption("hotspot");
  await page.getByLabel("Use of wlan1").selectOption("hotspot");
  await page.getByLabel("Use of ether5").selectOption("pppoe");
  await expect(page.getByText("Ports leave their current bridge")).toBeVisible();
  await page.getByLabel("Devices per login").fill("2");
  await expect(page.getByRole("switch", { name: "Block connection sharing" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save and apply" }).click();
  await expect(page.getByText("Saved. Waiting for the router's next check-in…")).toBeVisible();
  await page.getByRole("button", { name: "Simulate the check-in" }).click();
  await expect(page.getByText("Applied on the router (simulated)")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // 4. Done
  await expect(page.getByRole("heading", { name: `${name} is ready` })).toBeVisible();
  await expect(page.getByText(/ether2, wlan1 · 10\.5\.50\.0\/24 · 2 device\(s\) per login · sharing blocked/)).toBeVisible();
  await expect(page.getByText("ether5 · pool 10.10.0.0/16")).toBeVisible();

  await page.goto(`/routers?q=${encodeURIComponent(name)}`);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row.getByText("Cloudlink agent")).toBeVisible();
  await expect(row.getByText("Simulated")).toBeVisible();
  await expect(row.getByText("Hotspot")).toBeVisible();
});

test("TR-069: the ACS address, enrolling a device and its simulated check-in", async ({ page }) => {
  await login(page, E2E_USERS.owner);
  await page.goto("/routers");
  await page.getByRole("link", { name: "TR-069" }).first().click();
  await expect(page).toHaveURL(/\/tr069/);
  await expect(page.getByRole("heading", { name: /TR-069 devices/ })).toBeVisible();
  await expect(page.getByText("Test mode", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Network login" }).click();
  await expect(page.getByRole("dialog").getByText("https://acs.example.net:7547")).toBeVisible();
  await page.keyboard.press("Escape");

  // Pick a serial the test-mode ACS reports as checked in (the simulation is derived from the serial number).
  let serial = "";
  for (let i = 0; ; i++) {
    const candidate = `ONU${uniq()}${i}`.replace(/[^A-Za-z0-9]/g, "");
    if (parseInt(createHash("sha256").update(candidate).digest("hex").slice(0, 8), 16) % 20 >= 5) {
      serial = candidate;
      break;
    }
  }
  await page.getByRole("button", { name: "Enrol device" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel(/^Serial number/).fill(serial);
  await d.getByLabel("Label").fill("House 12");
  await d.getByRole("button", { name: "Enrol" }).click();
  await expect(d).toBeHidden();
  const row = page.getByRole("row", { name: new RegExp(serial) });
  await expect(row).toBeVisible();

  // The worker reads the device from the (simulated) ACS right after enrolment.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(serial) }).getByText("Checked in")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("row", { name: new RegExp(serial) }).getByText("Simulated")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(serial) }).getByText(/dBm/)).toBeVisible();

  await page.getByRole("button", { name: "Firmware" }).click();
  await expect(page.getByRole("dialog").getByText(/device/).first()).toBeVisible();
});
