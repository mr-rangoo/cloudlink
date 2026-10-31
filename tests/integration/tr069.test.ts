import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { enrolTr069Device, firmwareSummary, listTr069Devices, removeTr069Device, requestTr069Sync, syncTr069Devices, tr069ListQuery, updateTr069Device } from "@/server/services/tr069";
import { scheduleRecurringJobs } from "@/server/jobs/scheduler";
import { createSubscriber, subscriberInput } from "@/server/services/subscribers";
import { GET as listRoute } from "@/app/api/v1/tr069/devices/route";
import { contextFor, createOrg, createStaff, noParams, request, sessionFor } from "./fixtures";

const KEYS = ["TR069_ADAPTER", "TR069_NBI_URL", "TR069_RX_POWER_PARAM", "TR069_ACS_URL", "TR069_ACS_USERNAME", "APP_ENV"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.TR069_ADAPTER = "disabled";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A stand-in for the GenieACS northbound API: answers /devices/?query=…&projection=… from a fixed list.
const requests: string[] = [];
const ACS_DEVICES = [
  {
    _id: "48575443-HG8145V5-SN-ONE",
    _deviceId: { _Manufacturer: "Huawei", _OUI: "48575443", _ProductClass: "HG8145V5", _SerialNumber: "SN-ONE" },
    _lastInform: new Date(Date.now() - 5 * 60_000).toISOString(),
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: { _value: "V5R020C10S115" } },
      WANDevice: { "1": { WANConnectionDevice: { "1": { WANPPPConnection: { "1": { ExternalIPAddress: { _value: "10.10.0.23" } } } } }, X_GponInterfaceConfig: { RXPower: { _value: -28.4 } } } },
    },
  },
  {
    _id: "ZTE-F670L-SN-TWO",
    _deviceId: { _Manufacturer: "ZTE", _OUI: "ZTEEG", _ProductClass: "F670L", _SerialNumber: "SN-TWO" },
    _lastInform: new Date(Date.now() - 5 * 3600_000).toISOString(),
    Device: { DeviceInfo: { SoftwareVersion: { _value: "V9.0.11P1N12" } } },
  },
  { _id: "OTHER", _deviceId: { _SerialNumber: "NOT-ENROLLED" }, _lastInform: new Date().toISOString() },
];
let server: http.Server;
let nbiUrl = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    const query = JSON.parse(url.searchParams.get("query") ?? "{}") as { "_deviceId._SerialNumber"?: { $in: string[] } };
    const wanted = new Set(query["_deviceId._SerialNumber"]?.$in ?? []);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ACS_DEVICES.filter((d) => wanted.has(d._deviceId._SerialNumber))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  nbiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const all = tr069ListQuery.parse({});

describe("TR-069 devices", () => {
  it("enrols devices, reads them from GenieACS and classifies check-ins and signal", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const sub = await createSubscriber(ctx, subscriberInput.parse({ firstName: "Wanjiru", lastName: "Kamau", phone: "254712009001" }));
    const one = await enrolTr069Device(ctx, { serialNumber: "SN-ONE", subscriberId: sub.subscriber.id, label: "House 4" });
    await enrolTr069Device(ctx, { serialNumber: "SN-TWO" });
    await enrolTr069Device(ctx, { serialNumber: "SN-THREE", manufacturer: "Nokia" });
    await expect(enrolTr069Device(ctx, { serialNumber: "SN-ONE" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(enrolTr069Device(ctx, { serialNumber: "bad serial!" })).rejects.toBeTruthy();

    let list = await listTr069Devices(ctx, all);
    expect(list.summary).toEqual({ devices: 3, checkedIn: 0, notAnswering: 0, neverSeen: 3, weakSignal: 0 });
    expect(list.acs.adapter).toBe("disabled");
    expect(await syncTr069Devices(org.organization.id)).toMatchObject({ checked: 0, adapter: "disabled" });

    process.env.TR069_ADAPTER = "genieacs";
    process.env.TR069_NBI_URL = nbiUrl;
    process.env.TR069_RX_POWER_PARAM = "InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower";
    expect(await syncTr069Devices(org.organization.id)).toEqual({ checked: 3, seen: 2, adapter: "genieacs" });
    const sent = new URL(requests.at(-1)!, "http://x");
    expect(JSON.parse(sent.searchParams.get("query")!)).toEqual({ "_deviceId._SerialNumber": { $in: expect.arrayContaining(["SN-ONE", "SN-TWO", "SN-THREE"]) } });
    expect(sent.searchParams.get("projection")).toContain("InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower");

    list = await listTr069Devices(ctx, all);
    expect(list.summary).toEqual({ devices: 3, checkedIn: 1, notAnswering: 1, neverSeen: 1, weakSignal: 1 });
    const first = list.rows.find((r) => r.serialNumber === "SN-ONE")!;
    expect(first).toMatchObject({ state: "CHECKED_IN", productClass: "HG8145V5", softwareVersion: "V5R020C10S115", rxPowerDbm: -28.4, weakSignal: true, ipAddress: "10.10.0.23", simulated: false, label: "House 4" });
    expect(first.subscriber).toMatchObject({ displayName: "Wanjiru Kamau" });
    expect(list.rows.find((r) => r.serialNumber === "SN-TWO")).toMatchObject({ state: "NOT_ANSWERING", softwareVersion: "V9.0.11P1N12", rxPowerDbm: null });
    // A device the ACS knows but this ISP never enrolled is not added.
    expect(await db.tr069Device.count({ where: { serialNumber: "NOT-ENROLLED" } })).toBe(0);

    expect((await listTr069Devices(ctx, tr069ListQuery.parse({ tab: "never_seen" }))).rows.map((r) => r.serialNumber)).toEqual(["SN-THREE"]);
    expect((await listTr069Devices(ctx, tr069ListQuery.parse({ tab: "weak_signal" }))).rows.map((r) => r.serialNumber)).toEqual(["SN-ONE"]);
    expect((await listTr069Devices(ctx, tr069ListQuery.parse({ tab: "not_answering" }))).rows.map((r) => r.serialNumber)).toEqual(["SN-TWO"]);
    expect(await firmwareSummary(ctx)).toEqual(
      expect.arrayContaining([
        { model: "HG8145V5", version: "V5R020C10S115", devices: 1 },
        { model: "F670L", version: "V9.0.11P1N12", devices: 1 },
      ]),
    );

    // Recurring sync is scheduled only for organizations with devices when an ACS is connected.
    await scheduleRecurringJobs(new Date());
    expect(await db.backgroundOperation.count({ where: { type: "tr069.sync", organizationId: org.organization.id } })).toBeGreaterThanOrEqual(1);

    await updateTr069Device(ctx, one.id, { subscriberId: null, label: "" });
    expect(await db.tr069Device.findUniqueOrThrow({ where: { id: one.id } })).toMatchObject({ subscriberId: null, label: null });
    await removeTr069Device(ctx, one.id);
    expect(await db.tr069Device.count({ where: { organizationId: org.organization.id } })).toBe(2);
    const actions = (await db.auditLog.findMany({ where: { organizationId: org.organization.id, action: { startsWith: "tr069." } } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["tr069.device.enrol", "tr069.device.update", "tr069.device.remove"]));
  });

  it("keeps devices inside their organization and requires inventory permissions", async () => {
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    const device = await enrolTr069Device(ctx, { serialNumber: "SCOPE-1" });
    const other = await createOrg("Other ISP");
    const otherCtx = await contextFor(other.owner.id, other.organization.id);
    expect((await listTr069Devices(otherCtx, all)).summary.devices).toBe(0);
    await expect(updateTr069Device(otherCtx, device.id, { label: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removeTr069Device(otherCtx, device.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Same serial in another organization is a separate device.
    await enrolTr069Device(otherCtx, { serialNumber: "SCOPE-1" });
    // A subscriber from another organization cannot be assigned.
    const theirs = await createSubscriber(otherCtx, subscriberInput.parse({ firstName: "Other", lastName: "Customer", phone: "254712009002" }));
    await expect(updateTr069Device(ctx, device.id, { subscriberId: theirs.subscriber.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const cashier = await createStaff(org.organization.id, "cashier");
    const cashierCtx = await contextFor(cashier.user.id, org.organization.id);
    await expect(enrolTr069Device(cashierCtx, { serialNumber: "NOPE-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await listRoute(request("/api/v1/tr069/devices", { token: await sessionFor(cashier.user.id, org.organization.id) }), noParams);
    expect(res.status).toBe(403); // cashiers have no inventory access
    await expect(requestTr069Sync(ctx)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("simulates readings in test mode only, marked as simulated", async () => {
    process.env.TR069_ADAPTER = "mock";
    process.env.TR069_ACS_URL = "https://acs.example.net:7547";
    const org = await createOrg();
    const ctx = await contextFor(org.owner.id, org.organization.id);
    for (let i = 0; i < 12; i++) await enrolTr069Device(ctx, { serialNumber: `SIM-${i}` });
    await syncTr069Devices(org.organization.id);
    const list = await listTr069Devices(ctx, tr069ListQuery.parse({ pageSize: 50 }));
    expect(list.acs).toMatchObject({ acsUrl: "https://acs.example.net:7547", adapter: "mock" });
    expect(list.rows.filter((r) => r.lastInformAt).every((r) => r.simulated)).toBe(true);
    expect(list.summary.devices).toBe(12);
    expect(list.summary.checkedIn + list.summary.notAnswering + list.summary.neverSeen).toBe(12);

    process.env.APP_ENV = "production";
    await expect(syncTr069Devices(org.organization.id)).rejects.toThrow(/not allowed in production/);
  });
});
