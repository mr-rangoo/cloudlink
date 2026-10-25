import type { PermissionKey } from "@/server/auth/permissions";

/**
 * Staff navigation catalogue. `available: false` modules render an explicit
 * "not yet available" page naming the phase that delivers them, so no link leads to a fake screen.
 */
export interface NavItem {
  slug: string;
  href: string;
  label: string;
  icon: string;
  permission: PermissionKey;
  group: string;
  available: boolean;
  phase: number;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { slug: "dashboard", href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", permission: "dashboard.view", group: "Overview", available: true, phase: 1, description: "Key metrics and alerts" },
  { slug: "leads", href: "/leads", label: "CRM / Leads", icon: "UserPlus", permission: "leads.read", group: "Customers", available: true, phase: 2, description: "Sales pipeline and lead conversion" },
  { slug: "subscribers", href: "/subscribers", label: "Subscribers", icon: "Users", permission: "subscribers.read", group: "Customers", available: true, phase: 2, description: "Subscriber accounts and contacts" },
  { slug: "packages", href: "/packages", label: "Packages", icon: "Package", permission: "packages.read", group: "Customers", available: true, phase: 2, description: "Service plans and pricing" },
  { slug: "subscriptions", href: "/subscriptions", label: "Subscriptions", icon: "Repeat", permission: "subscriptions.read", group: "Customers", available: true, phase: 2, description: "Subscription lifecycle" },
  { slug: "invoices", href: "/invoices", label: "Invoices", icon: "FileText", permission: "invoices.read", group: "Billing", available: true, phase: 3, description: "Invoices and billing schedules" },
  { slug: "payments", href: "/payments", label: "Payments", icon: "Wallet", permission: "payments.read", group: "Billing", available: true, phase: 3, description: "Payments and allocations" },
  { slug: "reconciliation", href: "/reconciliation", label: "Reconciliation", icon: "Scale", permission: "payments.reconcile", group: "Billing", available: true, phase: 3, description: "Unmatched payments and ledger review" },
  { slug: "expenses", href: "/expenses", label: "Expenses", icon: "Receipt", permission: "expenses.read", group: "Billing", available: true, phase: 3, description: "Operating expenses" },
  { slug: "collections", href: "/collections", label: "Collections", icon: "HandCoins", permission: "expenses.read", group: "Billing", available: true, phase: 3, description: "Collections and withdrawals" },
  { slug: "vouchers", href: "/vouchers", label: "Vouchers", icon: "Ticket", permission: "vouchers.read", group: "Network", available: false, phase: 6, description: "Hotspot voucher batches" },
  { slug: "routers", href: "/routers", label: "Routers", icon: "Router", permission: "routers.read", group: "Network", available: false, phase: 7, description: "MikroTik router inventory" },
  { slug: "sessions", href: "/sessions", label: "Network Sessions", icon: "Activity", permission: "network.read", group: "Network", available: false, phase: 7, description: "PPPoE/Hotspot sessions and operations" },
  { slug: "support", href: "/support", label: "Support", icon: "LifeBuoy", permission: "support.read", group: "Service", available: false, phase: 4, description: "Support tickets" },
  { slug: "notifications", href: "/notifications", label: "Notifications", icon: "Bell", permission: "notifications.read", group: "Service", available: false, phase: 4, description: "Email/SMS notifications" },
  { slug: "reports", href: "/reports", label: "Reports", icon: "BarChart3", permission: "reports.read", group: "Insights", available: false, phase: 5, description: "Revenue, receivables and subscriber reports" },
  { slug: "staff", href: "/staff", label: "Staff & Permissions", icon: "ShieldCheck", permission: "staff.read", group: "Administration", available: false, phase: 5, description: "Staff, roles and permissions" },
  { slug: "branches", href: "/branches", label: "Branches", icon: "Building2", permission: "branches.read", group: "Administration", available: false, phase: 5, description: "Branch management" },
  { slug: "inventory", href: "/inventory", label: "Inventory", icon: "Boxes", permission: "inventory.read", group: "Administration", available: false, phase: 5, description: "Equipment inventory" },
  { slug: "integrations", href: "/integrations", label: "Integrations", icon: "Plug", permission: "integrations.read", group: "Administration", available: false, phase: 5, description: "Provider configuration and status" },
  { slug: "audit-logs", href: "/audit-logs", label: "Audit Logs", icon: "ScrollText", permission: "audit.read", group: "Administration", available: false, phase: 5, description: "Security and change history" },
  { slug: "settings", href: "/settings", label: "Settings", icon: "Settings", permission: "settings.write", group: "Administration", available: false, phase: 5, description: "Organization settings" },
];

export function findNavItem(slug: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.slug === slug);
}
