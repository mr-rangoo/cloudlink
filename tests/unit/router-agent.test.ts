import { describe, expect, it } from "vitest";
import {
  agentInstallLines,
  agentSource,
  buildServicesScript,
  checkAgainstReport,
  guessWan,
  parseAgentReport,
  parseAgentResult,
  parseIpv4Network,
  planServices,
  servicePorts,
  servicesInput,
  simulatedReport,
  unlinkScript,
  type ServicesConfig,
} from "@/server/domain/router-agent";
import { buildSetupScript } from "@/server/domain/routeros-setup";

const URL = "https://billing.example.net/api/v1/routers/agent/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";

const config = (patch: Partial<ServicesConfig> = {}) =>
  servicesInput.parse({
    hotspot: true,
    pppoe: true,
    wanInterface: "ether1",
    ports: [
      { name: "ether2", use: "hotspot" },
      { name: "ether3", use: "hotspot" },
      { name: "ether4", use: "pppoe" },
      { name: "wlan1", use: "both" },
    ],
    ...patch,
  });

describe("router agent script", () => {
  it("reports, fetches over verified HTTPS and imports, on one line", () => {
    const src = agentSource({ checkInUrl: URL, verifyTls: true });
    expect(src).not.toContain("\n");
    expect(src).toContain(`:local u "${URL}"`);
    expect(src).toContain("/interface find dynamic=no");
    expect(src).toContain("http-method=post");
    expect(src).toContain('dst-path="cloudlink-agent.rsc" check-certificate=yes-without-crl');
    expect(src).toContain('/import file-name="cloudlink-agent.rsc"');
    expect(src).toContain('http-data="status=failed"');
    expect(agentSource({ checkInUrl: URL, verifyTls: false })).not.toContain("check-certificate");
    expect(agentSource({ checkInUrl: URL.replace("https", "http"), verifyTls: true })).not.toContain("check-certificate");
  });

  it("installs as an escaped script with a one-minute scheduler and names the router", () => {
    const lines = agentInstallLines('Core "West" $1', { checkInUrl: URL, verifyTls: true });
    expect(lines[0]).toBe('/system identity set name="Core \\"West\\" \\$1"');
    const add = lines.find((l) => l.startsWith("/system script add"))!;
    // Variables are escaped inside the source string so they are not expanded at install time.
    expect(add).toContain("\\$d");
    expect(add).toContain('\\"v=1\\\\nidentity=\\"');
    expect(add).not.toContain(" $d");
    expect(lines.some((l) => l.includes("/system scheduler add name=\"cloudlink-agent\" interval=1m start-time=startup"))).toBe(true);
    expect(lines.at(-1)).toContain("/system script run cloudlink-agent");
  });

  it("is placed in the setup script before the file deletes itself", () => {
    const script = buildSetupScript({
      routerName: "Core",
      apiPort: 8728,
      useTls: false,
      password: "p",
      managementSources: ["10.8.0.1/32"],
      agentLines: agentInstallLines("Core", { checkInUrl: URL, verifyTls: true }),
      generatedAt: new Date("2026-11-01T00:00:00Z"),
    });
    expect(script.indexOf("/system scheduler add")).toBeGreaterThan(0);
    expect(script.indexOf("/system scheduler add")).toBeLessThan(script.indexOf('/file remove [find name="cloudlink-setup.rsc"]'));
    expect(unlinkScript()).toContain('/system scheduler remove [find name="cloudlink-agent"]');
  });
});

describe("check-in report", () => {
  const body = [
    "v=1",
    "identity=Core-West",
    "version=7.16.2 (stable)",
    "board=hAP ax2",
    "if=ether1|ether|true",
    "if=ether2|ether|false",
    "if=wlan1|wlan|true",
    "if=bridge|bridge|true",
    "if=pppoe-out1|pppoe-out|true",
    'if=bad"name|ether|true',
    "addr=192.168.88.1/24|bridge",
    "addr=10.8.0.9/32|wg0",
    "addr=not-an-ip|ether1",
    "port=ether2|bridge",
    "port=wlan1|bridge",
    "dhcp=ether1|192.0.2.10/24",
    "junk line",
  ].join("\n");

  it("parses known lines and drops malformed ones", () => {
    const r = parseAgentReport(body);
    expect(r).toMatchObject({ identity: "Core-West", version: "7.16.2 (stable)", board: "hAP ax2" });
    expect(r.interfaces.map((i) => i.name)).toEqual(["ether1", "ether2", "wlan1", "bridge", "pppoe-out1"]);
    expect(r.addresses).toEqual([
      { address: "192.168.88.1/24", interface: "bridge" },
      { address: "10.8.0.9/32", interface: "wg0" },
    ]);
    expect(r.dhcpClients).toEqual([{ interface: "ether1", address: "192.0.2.10/24" }]);
    expect(r.simulated).toBeUndefined();
  });

  it("lists customer ports with their current bridge and guesses the internet port", () => {
    const r = parseAgentReport(body);
    expect(servicePorts(r)).toEqual([
      { name: "ether1", type: "ether", running: true, bridge: null, addresses: [] },
      { name: "ether2", type: "ether", running: false, bridge: "bridge", addresses: [] },
      { name: "wlan1", type: "wlan", running: true, bridge: "bridge", addresses: [] },
    ]);
    expect(guessWan(r)).toBe("ether1");
  });
});

describe("services configuration", () => {
  it("validates services, ports and networks", () => {
    const issues = (patch: Record<string, unknown>) => servicesInput.safeParse({ hotspot: true, pppoe: false, wanInterface: "ether1", ports: [{ name: "ether2", use: "hotspot" }], ...patch }).error?.issues.map((i) => i.message) ?? [];
    expect(issues({})).toEqual([]);
    expect(issues({ hotspot: false })).toContain("Choose at least one service");
    expect(issues({ ports: [{ name: "ether1", use: "hotspot" }] })).toContain("The internet port cannot also serve customers");
    expect(issues({ ports: [{ name: "ether2", use: "pppoe" }] })).toEqual(expect.arrayContaining(["PPPoE is not selected", "Choose at least one port for the hotspot"]));
    expect(issues({ hotspotNetwork: "10.5.50.1/24" })).toContain("Use the network address (10.5.50.0/24)");
    expect(issues({ hotspotNetwork: "8.8.8.0/24" })[0]).toMatch(/private network/);
    expect(issues({ hotspotNetwork: "10.5.50.0/30" })[0]).toMatch(/prefix between/);
    expect(issues({ pppoe: true, ports: [{ name: "ether2", use: "both" }], pppoeNetwork: "10.5.0.0/16" })).toContain("Overlaps the hotspot network");
    expect(parseIpv4Network("172.20.0.0/16", 16, 28)).toEqual({ base: 0xac140000, prefix: 16 });
  });

  it("plans bridges, PPPoE servers and address pools", () => {
    const plan = planServices(config());
    expect(plan.hotspotPorts).toEqual(["ether2", "ether3", "wlan1"]);
    expect(plan.pppoePorts).toEqual(["ether4"]);
    expect(plan.pppoeServers).toEqual(["cloudlink-pppoe", "cloudlink-hotspot"]);
    expect(plan.hotspot).toEqual({ network: "10.5.50.0/24", prefix: 24, gateway: "10.5.50.1", poolRange: "10.5.50.10-10.5.50.254" });
    expect(plan.pppoe).toEqual({ network: "10.10.0.0/16", prefix: 16, localAddress: "10.10.0.1", poolRange: "10.10.0.2-10.10.255.254" });
    expect(planServices(config({ hotspotNetwork: "192.168.50.0/29" })).hotspot!.poolRange).toBe("192.168.50.2-192.168.50.6");
  });

  it("checks ports and networks against what the router reported", () => {
    const report = simulatedReport("Core", null);
    expect(checkAgainstReport(config(), report)).toEqual([]);
    expect(checkAgainstReport(config({ ports: [{ name: "ether9", use: "hotspot" }, { name: "ether4", use: "pppoe" }] }), report)[0]!.message).toBe("The router did not report a port called ether9");
    expect(checkAgainstReport(config({ hotspotNetwork: "192.168.88.0/24" }), report)).toEqual([{ path: "hotspotNetwork", message: "Overlaps 192.168.88.1/24 on bridge" }]);
  });

  it("builds an idempotent services script that confirms itself last", () => {
    const script = buildServicesScript({
      routerName: "Core",
      changeId: "0193f1c2-0000-7000-8000-000000000001",
      config: config({ devicesPerLogin: 2, hotspotDnsName: "wifi.skyline" }),
      resultUrl: `${URL}/result`,
      verifyTls: true,
      portalHost: "billing.example.net",
      loginUrl: "https://billing.example.net/api/v1/hotspot-files/r1/login.html",
      generatedAt: new Date("2026-11-01T00:00:00Z"),
    });
    const lines = script.split("\n");
    // Clean-up touches only what Cloudlink created.
    expect(script).toContain('/interface bridge port remove [find comment="cloudlink"]');
    expect(script).toContain('/interface bridge port add bridge="cloudlink-hotspot" interface="wlan1" comment="cloudlink"');
    expect(script).toContain('/interface bridge port add bridge="cloudlink-pppoe" interface="ether4" comment="cloudlink"');
    expect(script).toContain("/ip address add address=10.5.50.1/24 interface=\"cloudlink-hotspot\"");
    expect(script).toContain('dns-name="wifi.skyline"');
    expect(script).toContain('/ip hotspot user profile set [find name="default"] shared-users=2');
    expect(script).toContain('action=change-ttl new-ttl=set:1 passthrough=no comment="cloudlink-no-sharing"');
    expect(script).toContain('/interface pppoe-server server add service-name="cloudlink" interface="cloudlink-pppoe"');
    expect(script).toContain('/interface pppoe-server server add service-name="cloudlink" interface="cloudlink-hotspot"');
    expect(script).toContain('src-address=10.10.0.0/16 out-interface="ether1" action=masquerade');
    expect(script).toContain('in-interface="ether1" protocol=udp dst-port=53 action=drop');
    expect(script).toContain('walled-garden add dst-host="billing.example.net"');
    expect(lines.filter((l) => l.startsWith("/tool fetch") && l.includes("/result")).length).toBe(1);
    expect(lines.findIndex((l) => l.includes('http-data="status=applied&change=0193f1c2-0000-7000-8000-000000000001"'))).toBeGreaterThan(lines.findIndex((l) => l.includes("masquerade")));
    // No multi-line blocks: RouterOS imports line by line.
    for (const l of lines) expect((l.match(/\{/g) ?? []).length).toBe((l.match(/\}/g) ?? []).length);

    const open = buildServicesScript({ routerName: "Core", changeId: "x", config: config({ blockSharing: false, pppoe: false, ports: [{ name: "ether2", use: "hotspot" }] }), resultUrl: `${URL}/result`, verifyTls: false, portalHost: null, loginUrl: null, generatedAt: new Date() });
    expect(open).not.toContain("change-ttl");
    expect(open).not.toContain("pppoe-server server add");
    expect(open).toContain(':do { /interface bridge remove [find name="cloudlink-pppoe"] } on-error={}');
    expect(open).not.toContain("check-certificate");
  });

  it("parses the router's confirmation", () => {
    expect(parseAgentResult("status=applied&change=0193F1C2-0000-7000-8000-000000000001")).toEqual({ status: "applied", changeId: "0193f1c2-0000-7000-8000-000000000001" });
    expect(parseAgentResult("status=failed")).toEqual({ status: "failed", changeId: null });
    expect(parseAgentResult("status=ok&change=../../x")).toEqual({ status: null, changeId: null });
  });
});
