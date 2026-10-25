export type SubscriptionStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "EXPIRED" | "CANCELLED";
export type SubscriptionAction = "activate" | "renew" | "suspend" | "reactivate" | "cancel" | "expire";

/**
 * Allowed subscription transitions. CANCELLED is terminal.
 * Billing state only; network provisioning status is tracked separately (Phase 7).
 */
const TRANSITIONS: Record<SubscriptionAction, Partial<Record<SubscriptionStatus, SubscriptionStatus>>> = {
  activate: { PENDING: "ACTIVE" },
  renew: { PENDING: "ACTIVE", ACTIVE: "ACTIVE", SUSPENDED: "ACTIVE", EXPIRED: "ACTIVE" },
  suspend: { ACTIVE: "SUSPENDED" },
  reactivate: { SUSPENDED: "ACTIVE" },
  cancel: { PENDING: "CANCELLED", ACTIVE: "CANCELLED", SUSPENDED: "CANCELLED", EXPIRED: "CANCELLED" },
  expire: { ACTIVE: "EXPIRED", SUSPENDED: "EXPIRED" },
};

export function nextStatus(current: SubscriptionStatus, action: SubscriptionAction): SubscriptionStatus | null {
  return TRANSITIONS[action][current] ?? null;
}

export type StaffSubscriptionAction = Exclude<SubscriptionAction, "expire">;

export function allowedActions(current: SubscriptionStatus): StaffSubscriptionAction[] {
  return (Object.keys(TRANSITIONS) as SubscriptionAction[]).filter((a): a is StaffSubscriptionAction => a !== "expire" && TRANSITIONS[a][current] !== undefined);
}

/**
 * Renewal policy:
 * - ACTIVE (or SUSPENDED) whose current period has not ended: the next period continues seamlessly from the current end.
 * - PENDING, EXPIRED, or a lapsed period: service restarts with a new anchor at the renewal time.
 */
export function renewalContinues(status: SubscriptionStatus, currentPeriodEnd: Date | null, now: Date): boolean {
  return (status === "ACTIVE" || status === "SUSPENDED") && currentPeriodEnd !== null && currentPeriodEnd.getTime() > now.getTime();
}
