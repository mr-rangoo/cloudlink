import { Badge, type Tone } from "@/components/ui/feedback";

const SUBSCRIPTION: Record<string, Tone> = { ACTIVE: "success", PENDING: "info", SUSPENDED: "warning", EXPIRED: "danger", CANCELLED: "neutral" };
const RECORD: Record<string, Tone> = { ACTIVE: "success", INACTIVE: "warning", ARCHIVED: "neutral" };
const LEAD: Record<string, Tone> = { NEW: "info", CONTACTED: "info", QUALIFIED: "info", SITE_SURVEY: "warning", PROPOSAL: "warning", WON: "success", LOST: "neutral" };

export function humanize(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function SubscriptionStatusBadge({ status }: { status: string }) {
  return <Badge tone={SUBSCRIPTION[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function RecordStatusBadge({ status }: { status: string }) {
  return <Badge tone={RECORD[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function LeadStageBadge({ stage }: { stage: string }) {
  return <Badge tone={LEAD[stage] ?? "neutral"}>{humanize(stage)}</Badge>;
}

export const SERVICE_LABEL: Record<string, string> = { PPPOE: "PPPoE", HOTSPOT: "Hotspot", STATIC_IP: "Static IP", OTHER: "Other" };

export function formatSpeed(kbps: number | null | undefined): string {
  if (!kbps) return "—";
  return kbps >= 1000 ? `${(kbps / 1000).toLocaleString("en-KE", { maximumFractionDigits: 1 })} Mbps` : `${kbps} kbps`;
}

export function formatInterval(unit: string, count: number): string {
  const u = unit.toLowerCase();
  return count === 1 ? `per ${u}` : `per ${count} ${u}s`;
}
