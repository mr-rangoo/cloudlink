import "server-only";
import { db } from "@/server/db/client";
import { hasPermission, type StaffContext } from "@/server/auth/context";

export interface AlertItem {
  key: string;
  tone: "danger" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
  count: number;
}

/**
 * Staff notification centre: live counts of things needing attention, filtered by permission.
 * Nothing here is stored or estimated; each item links to the page that resolves it.
 */
export async function staffAlerts(ctx: StaffContext): Promise<AlertItem[]> {
  const org = ctx.organizationId;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const checks: Array<Promise<AlertItem | null>> = [];

  if (hasPermission(ctx, "payments.reconcile")) {
    checks.push(
      db.payment.count({ where: { organizationId: org, status: "CONFIRMED", subscriberId: null } }).then((n) =>
        n ? { key: "unmatched", tone: "warning", title: "Unmatched payments", detail: `${n} confirmed payment(s) need a subscriber`, href: "/reconciliation", count: n } : null,
      ),
    );
  }
  if (hasPermission(ctx, "invoices.read")) {
    checks.push(
      db.invoice.count({ where: { organizationId: org, status: { in: ["OPEN", "PARTIALLY_PAID"] }, dueAt: { lt: now } } }).then((n) =>
        n ? { key: "overdue", tone: "warning", title: "Overdue invoices", detail: `${n} invoice(s) past their due date`, href: "/invoices?status=OVERDUE", count: n } : null,
      ),
    );
  }
  if (hasPermission(ctx, "support.read")) {
    checks.push(
      db.supportTicket.count({ where: { organizationId: org, status: { in: ["OPEN", "IN_PROGRESS"] }, priority: { in: ["HIGH", "URGENT"] }, assigneeId: null } }).then((n) =>
        n ? { key: "urgent-unassigned", tone: "danger", title: "Unassigned urgent tickets", detail: `${n} high-priority ticket(s) without an owner`, href: "/support?assignee=unassigned", count: n } : null,
      ),
    );
    checks.push(
      db.supportTicket.count({ where: { organizationId: org, assigneeId: ctx.userId, status: "OPEN" } }).then((n) =>
        n ? { key: "my-open", tone: "info", title: "Tickets awaiting your reply", detail: `${n} open ticket(s) assigned to you`, href: "/support?assignee=me", count: n } : null,
      ),
    );
  }
  if (hasPermission(ctx, "notifications.read")) {
    checks.push(
      db.notification.count({ where: { organizationId: org, status: "FAILED", createdAt: { gte: weekAgo } } }).then((n) =>
        n ? { key: "notify-failed", tone: "danger", title: "Failed notifications", detail: `${n} message(s) failed in the last 7 days`, href: "/notifications?status=FAILED", count: n } : null,
      ),
    );
  }
  if (hasPermission(ctx, "integrations.read")) {
    checks.push(
      db.backgroundOperation.count({ where: { organizationId: org, status: "DEAD", updatedAt: { gte: weekAgo } } }).then((n) =>
        n ? { key: "jobs-dead", tone: "danger", title: "Failed background jobs", detail: `${n} job(s) exhausted their retries`, href: "/notifications", count: n } : null,
      ),
    );
  }
  if (hasPermission(ctx, "payments.reconcile")) {
    checks.push(
      db.paymentAttempt.count({ where: { organizationId: org, status: "UNKNOWN", createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } }).then((n) =>
        n ? { key: "mpesa-unknown", tone: "warning", title: "M-Pesa payments to review", detail: `${n} request(s) with an unknown outcome`, href: "/payments/requests?status=UNKNOWN", count: n } : null,
      ),
    );
  }
  if (hasPermission(ctx, "network.read")) {
    checks.push(
      db.routerAlert.count({ where: { organizationId: org, status: "OPEN" } }).then((n) =>
        n ? { key: "network-alerts", tone: "danger", title: "Network alerts", detail: `${n} open router or network-operation alert(s)`, href: "/sessions?tab=alerts", count: n } : null,
      ),
    );
  }
  return (await Promise.all(checks)).filter((a): a is AlertItem => a !== null);
}
