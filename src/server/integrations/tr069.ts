import "server-only";
import { createHash } from "node:crypto";

/**
 * TR-069 (CWMP) device status from an ACS. Cloudlink is not an ACS: CPEs connect to a separate ACS (GenieACS), and the
 * worker reads what the ACS knows about the devices an organization enrolled, matched by serial number. Devices are
 * never added to an organization from the ACS, because the ACS cannot say which ISP a device belongs to.
 *
 *  - genieacs: GenieACS northbound API (TR069_NBI_URL), read only.
 *  - mock: deterministic simulated readings for test mode (refused in production); every reading is marked simulated.
 *  - disabled: no readings.
 */
export interface AcsDevice {
  acsId: string;
  serialNumber: string;
  manufacturer: string | null;
  oui: string | null;
  productClass: string | null;
  softwareVersion: string | null;
  lastInformAt: Date | null;
  rxPowerDbm: number | null;
  ipAddress: string | null;
  simulated?: boolean;
}

export interface Tr069Adapter {
  name: "genieacs" | "mock" | "disabled";
  /** What the ACS knows about these serial numbers (devices it has never seen are left out). */
  fetchDevices(serials: string[]): Promise<AcsDevice[]>;
}

export function tr069AdapterName(): Tr069Adapter["name"] {
  const v = process.env.TR069_ADAPTER;
  return v === "genieacs" || v === "mock" ? v : "disabled";
}

const SOFTWARE = ["InternetGatewayDevice.DeviceInfo.SoftwareVersion", "Device.DeviceInfo.SoftwareVersion"];
const ADDRESS = [
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress",
  "Device.IP.Interface.1.IPv4Address.1.IPAddress",
];

function valueAt(device: Record<string, unknown>, path: string): unknown {
  let node: unknown = device;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node && typeof node === "object" && "_value" in node ? (node as { _value: unknown })._value : undefined;
}

const text = (v: unknown, max = 64) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Parse one GenieACS device document (exported for tests). */
export function parseGenieDevice(doc: Record<string, unknown>, rxParam: string): AcsDevice | null {
  const id = (doc._deviceId ?? {}) as Record<string, unknown>;
  const serial = text(id._SerialNumber);
  if (!serial || typeof doc._id !== "string") return null;
  const inform = typeof doc._lastInform === "string" ? new Date(doc._lastInform) : null;
  const rx = rxParam ? Number(valueAt(doc, rxParam)) : NaN;
  return {
    acsId: doc._id.slice(0, 200),
    serialNumber: serial,
    manufacturer: text(id._Manufacturer),
    oui: text(id._OUI, 6),
    productClass: text(id._ProductClass),
    softwareVersion: SOFTWARE.map((p) => text(valueAt(doc, p))).find(Boolean) ?? null,
    lastInformAt: inform && !Number.isNaN(inform.getTime()) ? inform : null,
    // Only plausible optical levels are kept; vendors that report other units need a different parameter.
    rxPowerDbm: Number.isFinite(rx) && rx >= -60 && rx <= 10 ? Math.round(rx * 100) / 100 : null,
    ipAddress: ADDRESS.map((p) => text(valueAt(doc, p), 45)).find((v) => v && /^[0-9a-fA-F:.]+$/.test(v)) ?? null,
  };
}

const genieacs: Tr069Adapter = {
  name: "genieacs",
  async fetchDevices(serials) {
    const base = (process.env.TR069_NBI_URL ?? "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) throw new Error("TR069_NBI_URL is not set");
    const rxParam = process.env.TR069_RX_POWER_PARAM ?? "";
    const projection = ["_id", "_deviceId", "_lastInform", ...SOFTWARE, ...ADDRESS, ...(rxParam ? [rxParam] : [])].join(",");
    const out: AcsDevice[] = [];
    for (let i = 0; i < serials.length; i += 100) {
      const query = JSON.stringify({ "_deviceId._SerialNumber": { $in: serials.slice(i, i + 100) } });
      const res = await fetch(`${base}/devices/?query=${encodeURIComponent(query)}&projection=${encodeURIComponent(projection)}`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`ACS answered ${res.status}`);
      const docs = (await res.json()) as unknown;
      if (!Array.isArray(docs)) throw new Error("ACS answered with an unexpected body");
      for (const d of docs) {
        const parsed = d && typeof d === "object" ? parseGenieDevice(d as Record<string, unknown>, rxParam) : null;
        if (parsed) out.push(parsed);
      }
    }
    return out;
  },
};

const MODELS = [
  { manufacturer: "Huawei", productClass: "HG8145V5", software: "V5R020C10S115" },
  { manufacturer: "ZTE", productClass: "F670L", software: "V9.0.11P1N12" },
  { manufacturer: "Huawei", productClass: "EG8145X6", software: "V5R021C00S125" },
];

/** Test mode: stable readings derived from the serial number (about 1 in 10 never seen, 3 in 20 not answering). */
const mock: Tr069Adapter = {
  name: "mock",
  async fetchDevices(serials) {
    const now = Date.now();
    return serials.flatMap((serial) => {
      const h = parseInt(createHash("sha256").update(serial).digest("hex").slice(0, 8), 16);
      const bucket = h % 20;
      if (bucket < 2) return [];
      const m = MODELS[h % MODELS.length]!;
      const minutesAgo = bucket < 5 ? 180 + (h % 600) : h % 10;
      return [
        {
          acsId: `simulated-${serial}`,
          serialNumber: serial,
          manufacturer: m.manufacturer,
          oui: null,
          productClass: m.productClass,
          softwareVersion: m.software,
          lastInformAt: new Date(now - minutesAgo * 60_000),
          rxPowerDbm: -(14 + (h % 170) / 10),
          ipAddress: null,
          simulated: true,
        },
      ];
    });
  },
};

const disabled: Tr069Adapter = { name: "disabled", fetchDevices: async () => [] };

export function tr069Adapter(): Tr069Adapter {
  const name = tr069AdapterName();
  if (name === "mock" && process.env.APP_ENV === "production") throw new Error("The mock TR-069 adapter is not allowed in production");
  return name === "genieacs" ? genieacs : name === "mock" ? mock : disabled;
}
