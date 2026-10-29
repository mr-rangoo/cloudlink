import { describe, expect, it } from "vitest";
import { buildSetupScript, rosString, setupCommand } from "@/server/domain/routeros-setup";
import { parseEnv } from "@/server/env";

const base = { routerName: "Core-1", apiPort: 8728, useTls: false, password: "Abc23xyzQWERTY456789pqrs", managementSources: ["10.8.0.1/32"], generatedAt: new Date("2026-10-26T08:00:00Z") };

describe("router setup script", () => {
  it("creates a limited API user restricted to the management addresses and guards the API port", () => {
    const s = buildSetupScript(base);
    expect(s).toContain(`/user add name="cloudlink-api" group="cloudlink" password="Abc23xyzQWERTY456789pqrs" address="10.8.0.1/32"`);
    expect(s).toMatch(/policy=api,read,write,!local,.*!sensitive/);
    expect(s).toContain(`/ip service set api disabled=no port=8728 address="10.8.0.1/32"`);
    expect(s).toContain(`/ip service set api-ssl address="10.8.0.1/32"`);
    expect(s).toContain(`/ip firewall address-list add list="cloudlink-mgmt" address=10.8.0.1/32`);
    expect(s).toContain(`dst-port=8728 src-address-list=!cloudlink-mgmt action=drop`);
    expect(s).toContain(`/file remove [find name="cloudlink-setup.rsc"]`);
    expect(s).not.toMatch(/radius|walled-garden/);
    expect(s).not.toMatch(/0\.0\.0\.0\/0/);
  });

  it("uses API-SSL with a certificate, RADIUS and the walled garden only when asked", () => {
    const s = buildSetupScript({ ...base, apiPort: 8729, useTls: true, radius: { address: "10.8.0.5", secret: 'pa"ss$word\\x' }, hotspotHost: "billing.example.co.ke" });
    expect(s).toContain(`/certificate add name="cloudlink-api"`);
    expect(s).toContain(`/ip service set api-ssl disabled=no port=8729 address="10.8.0.1/32" certificate="cloudlink-api"`);
    expect(s).toContain(`/radius add service=ppp address=10.8.0.5 secret="pa\\"ss\\$word\\\\x"`);
    expect(s).toContain(`/ppp aaa set use-radius=yes accounting=yes interim-update=5m`);
    expect(s).toContain(`walled-garden add dst-host="billing.example.co.ke"`);
    expect(s).toContain(`walled-garden ip add dst-host="billing.example.co.ke" action=accept`);
    expect(s).not.toContain("login.html"); // no login page without its URL
  });

  it("installs the captive-portal login page on hotspot routers", () => {
    const s = buildSetupScript({ ...base, hotspotHost: "billing.example.co.ke", hotspotLoginUrl: "https://billing.example.co.ke/api/v1/hotspot-files/r1/login.html" });
    expect(s).toContain(`/tool fetch url="https://billing.example.co.ke/api/v1/hotspot-files/r1/login.html" dst-path=($dir . "/login.html")`);
    expect(s).toContain("login-by=cookie,http-chap,http-pap");
  });

  it("escapes RouterOS strings and keeps router names out of commands", () => {
    expect(rosString('a"b$c\\d')).toBe('"a\\"b\\$c\\\\d"');
    expect(rosString("line1\nline2")).toBe('"line1 line2"');
    const s = buildSetupScript({ ...base, routerName: 'Evil"; /system reset-configuration; #' });
    expect(s).not.toContain("reset-configuration;");
    expect(s.split("\n")[0]).toBe("# Cloudlink router setup for Evil system reset-configuration "); // a comment line: no quotes, semicolons or newlines
  });

  it("builds the one-line command", () => {
    expect(setupCommand("https://billing.example.co.ke/api/v1/routers/setup/tok")).toBe(
      '/tool fetch mode=https url="https://billing.example.co.ke/api/v1/routers/setup/tok" dst-path=cloudlink-setup.rsc; :delay 2s; /import file-name=cloudlink-setup.rsc;',
    );
    expect(setupCommand("http://localhost:3100/x")).toMatch(/^\/tool fetch mode=http /);
  });

  it("validates ROUTER_MANAGEMENT_SOURCES as private addresses", () => {
    const env = { APP_URL: "http://localhost:3100", DATABASE_URL: "postgresql://u:p@h/db", AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") };
    expect(parseEnv({ ...env, ROUTER_MANAGEMENT_SOURCES: "10.8.0.1, 10.9.0.0/24" }).ROUTER_MANAGEMENT_SOURCES).toBe("10.8.0.1, 10.9.0.0/24");
    expect(() => parseEnv({ ...env, ROUTER_MANAGEMENT_SOURCES: "41.90.1.1" })).toThrow(/ROUTER_MANAGEMENT_SOURCES/);
    expect(() => parseEnv({ ...env, ROUTER_MANAGEMENT_SOURCES: "nonsense" })).toThrow(/ROUTER_MANAGEMENT_SOURCES/);
  });
});
