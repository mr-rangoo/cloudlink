/**
 * Permission catalogue and default role templates.
 * Roles are per-organization copies of these templates and remain configurable.
 * Authorization is always enforced on the server via `requirePermission`.
 */
export const PERMISSIONS = {
  "dashboard.view": "View dashboard metrics",
  "leads.read": "View leads",
  "leads.write": "Create, edit and convert leads",
  "subscribers.read": "View subscribers",
  "subscribers.write": "Create and edit subscribers",
  "subscribers.import": "Import subscribers from CSV",
  "packages.read": "View packages",
  "packages.write": "Create and edit packages",
  "subscriptions.read": "View subscriptions",
  "subscriptions.write": "Activate, renew, suspend and cancel subscriptions",
  "invoices.read": "View invoices",
  "invoices.write": "Create draft invoices",
  "invoices.issue": "Issue and void invoices",
  "credit_notes.create": "Issue credit notes",
  "payments.read": "View payments",
  "payments.record": "Record manual cash/bank payments",
  "payments.allocate": "Allocate payments to invoices",
  "payments.reconcile": "Reconcile and review unmatched payments",
  "payments.refund": "Issue refunds and reversals",
  "payments.initiate": "Initiate M-Pesa payment requests",
  "ledger.read": "View ledger entries",
  "expenses.read": "View expenses and withdrawals",
  "expenses.write": "Record expenses and withdrawals",
  "vouchers.read": "View vouchers",
  "vouchers.write": "Generate voucher batches",
  "vouchers.export": "Export voucher codes",
  "routers.read": "View routers",
  "routers.write": "Register and edit routers and credentials",
  "network.read": "View sessions and network operations",
  "network.operate": "Execute approved network operations",
  "support.read": "View support tickets",
  "support.write": "Create and update support tickets",
  "notifications.read": "View notifications",
  "notifications.write": "Manage notification templates and send messages",
  "reports.read": "View reports",
  "reports.export": "Export reports and data",
  "staff.read": "View staff",
  "staff.write": "Invite, edit and disable staff",
  "roles.write": "Edit roles and permissions",
  "branches.read": "View branches",
  "branches.write": "Create and edit branches",
  "inventory.read": "View equipment inventory",
  "inventory.write": "Manage equipment inventory",
  "integrations.read": "View integration status",
  "integrations.write": "Configure integrations and credentials",
  "audit.read": "Search audit logs",
  "settings.write": "Edit organization settings",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

const READ_ALL = ALL_PERMISSIONS.filter((p) => p.endsWith(".read") || p === "dashboard.view");

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: PermissionKey[];
}

export const DEFAULT_ROLES: RoleTemplate[] = [
  {
    key: "owner",
    name: "Owner",
    description: "Organization-wide configuration and oversight.",
    permissions: [...ALL_PERMISSIONS],
  },
  {
    key: "admin",
    name: "Administrator",
    description: "Operational configuration and staff management.",
    permissions: ALL_PERMISSIONS.filter((p) => p !== "roles.write" && p !== "payments.refund"),
  },
  {
    key: "accountant",
    name: "Accountant",
    description: "Invoices, payments, reconciliation, credits, refunds, expenses and reports.",
    permissions: [
      "dashboard.view",
      "subscribers.read",
      "packages.read",
      "subscriptions.read",
      "invoices.read",
      "invoices.write",
      "invoices.issue",
      "credit_notes.create",
      "payments.read",
      "payments.record",
      "payments.allocate",
      "payments.reconcile",
      "payments.refund",
      "payments.initiate",
      "ledger.read",
      "expenses.read",
      "expenses.write",
      "reports.read",
      "reports.export",
      "audit.read",
    ],
  },
  {
    key: "cashier",
    name: "Cashier",
    description: "Authorized payment entry and receipts.",
    permissions: [
      "dashboard.view",
      "subscribers.read",
      "subscriptions.read",
      "invoices.read",
      "payments.read",
      "payments.record",
      "payments.allocate",
      "payments.initiate",
    ],
  },
  {
    key: "technician",
    name: "Network technician",
    description: "Router inventory, sessions, alerts and approved network operations.",
    permissions: [
      "dashboard.view",
      "subscribers.read",
      "subscriptions.read",
      "routers.read",
      "routers.write",
      "network.read",
      "network.operate",
      "inventory.read",
      "inventory.write",
      "vouchers.read",
      "support.read",
      "support.write",
      "integrations.read",
    ],
  },
  {
    key: "support",
    name: "Support agent",
    description: "Customer profiles, tickets and permitted communication.",
    permissions: [
      "dashboard.view",
      "subscribers.read",
      "subscriptions.read",
      "invoices.read",
      "payments.read",
      "network.read",
      "support.read",
      "support.write",
      "notifications.read",
    ],
  },
  {
    key: "sales",
    name: "Sales agent",
    description: "Leads, subscriber onboarding and assigned sales workflows.",
    permissions: [
      "dashboard.view",
      "leads.read",
      "leads.write",
      "subscribers.read",
      "subscribers.write",
      "packages.read",
      "subscriptions.read",
      "subscriptions.write",
      "vouchers.read",
    ],
  },
  {
    key: "auditor",
    name: "Read-only auditor",
    description: "Read-only access across modules.",
    permissions: READ_ALL,
  },
];
