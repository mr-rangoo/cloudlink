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

export { formatBytes, formatDuration } from "@/lib/format";
