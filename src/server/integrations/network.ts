import "server-only";
import { PermanentError } from "@/server/jobs/operations";

/**
 * Network adapter boundary (server-side only). Business code never talks to routers directly.
 * - mock: deterministic, changes nothing, results are labelled SIMULATED.
 * - routeros: implemented in phase 7 (private connectivity required); until then it reports NOT_IMPLEMENTED.
 * - disabled: network automation switched off; operations fail with a clear reason.
 */
export interface HotspotActivation {
  username: string;
  password: string;
  profile: string;
  uptimeLimitSeconds: number;
  rateLimit: string | null; // e.g. "5M/10M" (upload/download)
  macAddress: string | null;
}

export interface ActivationResult {
  status: "ACTIVE" | "SIMULATED";
  detail: string;
}

export interface NetworkAdapter {
  name: "mock" | "routeros" | "disabled";
  activateHotspotUser(req: HotspotActivation): Promise<ActivationResult>;
}

class MockNetworkAdapter implements NetworkAdapter {
  name = "mock" as const;
  async activateHotspotUser(req: HotspotActivation): Promise<ActivationResult> {
    return { status: "SIMULATED", detail: `Mock network adapter: hotspot user ${req.username.slice(0, 2)}*** was NOT created on any router.` };
  }
}

class UnavailableNetworkAdapter implements NetworkAdapter {
  constructor(public name: "routeros" | "disabled") {}
  async activateHotspotUser(): Promise<ActivationResult> {
    if (this.name === "disabled") throw new PermanentError("Network automation is disabled for this deployment.", "NETWORK_DISABLED");
    throw new PermanentError("RouterOS integration is not available yet.", "NOT_IMPLEMENTED");
  }
}

export function networkAdapter(): NetworkAdapter {
  const mode = process.env.NETWORK_ADAPTER ?? "mock";
  if (mode === "mock") return new MockNetworkAdapter();
  return new UnavailableNetworkAdapter(mode === "disabled" ? "disabled" : "routeros");
}

export function kbpsToRate(kbps: number | null | undefined): string | null {
  if (!kbps) return null;
  return kbps % 1024 === 0 ? `${kbps / 1024}M` : `${kbps}k`;
}
