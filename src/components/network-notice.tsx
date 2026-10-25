import { Alert } from "@/components/ui/feedback";

/** Explains what the configured network adapter actually does, so simulated results are never mistaken for real ones. */
export function AdapterNotice({ adapter }: { adapter: string }) {
  if (adapter === "mock") {
    return (
      <Alert tone="info" title="Mock network adapter">
        Health checks and operations are simulated. No router is contacted or changed, and every result is labelled “Simulated”.
      </Alert>
    );
  }
  if (adapter === "disabled") {
    return (
      <Alert tone="warning" title="Network automation is disabled">
        Operations fail with a clear reason until the deployment configures NETWORK_ADAPTER.
      </Alert>
    );
  }
  return null;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

export function formatBytes(value: string | null | undefined): string {
  if (!value) return "—";
  let n = Number(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("en-KE", { maximumFractionDigits: 1 })} ${units[i]}`;
}
