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

const INVOICE: Record<string, Tone> = { DRAFT: "neutral", OPEN: "info", PARTIALLY_PAID: "warning", PAID: "success", VOID: "neutral" };
const PAYMENT: Record<string, Tone> = { PENDING: "info", CONFIRMED: "success", FAILED: "danger", CANCELLED: "neutral", REVERSED: "danger", UNKNOWN: "warning" };

export function InvoiceStatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) return <Badge tone="danger">Overdue</Badge>;
  return <Badge tone={INVOICE[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function PaymentStatusBadge({ status }: { status: string }) {
  return <Badge tone={PAYMENT[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export const METHOD_LABEL: Record<string, string> = { CASH: "Cash", BANK_TRANSFER: "Bank transfer", MPESA: "M-Pesa", CHEQUE: "Cheque", CARD: "Card", OTHER: "Other" };

export const TICKET_TONE: Record<string, Tone> = { OPEN: "info", IN_PROGRESS: "warning", WAITING_ON_CUSTOMER: "neutral", RESOLVED: "success", CLOSED: "neutral" };
export const PRIORITY_TONE: Record<string, Tone> = { LOW: "neutral", NORMAL: "info", HIGH: "warning", URGENT: "danger" };

// ───────── Network (status words always accompany colour; simulated results are labelled as such) ─────────

const NETWORK: Record<string, { label: string; tone: Tone }> = {
  NOT_PROVISIONED: { label: "Not provisioned", tone: "neutral" },
  PENDING: { label: "Change pending", tone: "info" },
  ACTIVE: { label: "Enabled", tone: "success" },
  DISABLED: { label: "Disabled", tone: "warning" },
  SIMULATED_ACTIVE: { label: "Enabled (simulated)", tone: "info" },
  SIMULATED_DISABLED: { label: "Disabled (simulated)", tone: "neutral" },
  ERROR: { label: "Needs attention", tone: "danger" },
};

export function NetworkStatusBadge({ status }: { status: string }) {
  const s = NETWORK[status] ?? { label: humanize(status), tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const OPERATION: Record<string, Tone> = { QUEUED: "info", RUNNING: "info", RETRYING: "warning", SUCCEEDED: "success", SIMULATED: "neutral", FAILED: "danger", CANCELLED: "neutral" };

export function OperationStatusBadge({ status }: { status: string }) {
  return <Badge tone={OPERATION[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

const ROUTER: Record<string, Tone> = { ONLINE: "success", OFFLINE: "danger", ERROR: "danger", UNKNOWN: "neutral" };

export function RouterStatusBadge({ status, adapter }: { status: string; adapter?: string }) {
  if (status === "UNKNOWN" && adapter === "mock") return <Badge tone="neutral">Simulated</Badge>;
  return <Badge tone={ROUTER[status] ?? "neutral"}>{status === "UNKNOWN" ? "Not checked" : humanize(status)}</Badge>;
}

export const VERIFICATION_LABEL: Record<string, string> = {
  VERIFIED: "Verified by read-back",
  NOT_SUPPORTED: "Not verifiable (simulated)",
  UNVERIFIED: "Not verified",
  PENDING: "Pending",
};
