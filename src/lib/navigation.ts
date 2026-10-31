import type { PermissionKey } from "@/server/auth/permissions";

/**
 * Staff navigation catalogue. `available: false` modules render an explicit
 * "not yet available" page naming the phase that delivers them, so no link leads to a fake screen.
 * Items with a `parent` are shown inside that collapsible entry (e.g. Billing → Payments).
 */
export interface NavItem {
  slug: string;
  href: string;
  label: string;
  icon: string;
  permission: PermissionKey;
  group: string;
  parent?: string;
  available: boolean;
  phase: number;
  description: string;
}

/** Collapsible sidebar entries that hold related pages. */
export const NAV_PARENTS: Record<string, { label: string; icon: string }> = {
  devices: { label: "Devices", icon: "Router" },
  billing: { label: "Billing", icon: "Wallet" },
};

export const NAV_ITEMS: NavItem[] = [
  { slug: "dashboard", href: "/dashboard", label: "Overview", icon: "LayoutDashboard", permission: "dashboard.view", group: "Overview", available: true, phase: 1, description: "Today at a glance: money, sessions and what needs attention" },
  { slug: "subscribers", href: "/subscribers", label: "Subscribers", icon: "Users", permission: "subscribers.read", group: "Customers", available: true, phase: 2, description: "Subscriber accounts and contacts" },
  { slug: "leads", href: "/leads", label: "Leads", icon: "UserPlus", permission: "leads.read", group: "Customers", available: true, phase: 2, description: "Sales pipeline and lead conversion" },
  { slug: "support", href: "/support", label: "Tickets", icon: "LifeBuoy", permission: "support.read", group: "Customers", available: true, phase: 4, description: "Support tickets and assistant chats" },
  { slug: "subscriptions", href: "/subscriptions", label: "Subscriptions", icon: "Repeat", permission: "subscriptions.read", group: "Customers", available: true, phase: 2, description: "Subscription lifecycle" },
  { slug: "sessions", href: "/sessions", label: "Live sessions", icon: "Wifi", permission: "network.read", group: "Network", available: true, phase: 7, description: "Who is online now, operations and alerts" },
  { slug: "packages", href: "/packages", label: "Plans", icon: "Package", permission: "packages.read", group: "Network", available: true, phase: 2, description: "Internet plans and pricing" },
  { slug: "routers", href: "/routers", label: "Routers", icon: "Router", permission: "routers.read", group: "Network", parent: "devices", available: true, phase: 7, description: "MikroTik routers (NAS)" },
  { slug: "tr069", href: "/tr069", label: "TR-069", icon: "RadioTower", permission: "inventory.read", group: "Network", parent: "devices", available: true, phase: 19, description: "Customer devices managed over TR-069: check-ins, signal and firmware" },
  { slug: "inventory", href: "/inventory", label: "Equipment", icon: "Boxes", permission: "inventory.read", group: "Network", parent: "devices", available: true, phase: 5, description: "Customer equipment and stock" },
  { slug: "payments", href: "/payments", label: "Payments", icon: "Wallet", permission: "payments.read", group: "Finance", parent: "billing", available: true, phase: 3, description: "Payments ledger" },
  { slug: "invoices", href: "/invoices", label: "Invoices", icon: "FileText", permission: "invoices.read", group: "Finance", parent: "billing", available: true, phase: 3, description: "Invoices and billing schedules" },
  { slug: "expenses", href: "/expenses", label: "Expenses", icon: "Receipt", permission: "expenses.read", group: "Finance", parent: "billing", available: true, phase: 3, description: "Operating expenses" },
  { slug: "reconciliation", href: "/reconciliation", label: "Reconciliation", icon: "Scale", permission: "payments.reconcile", group: "Finance", parent: "billing", available: true, phase: 3, description: "Unmatched payments and ledger review" },
  { slug: "collections", href: "/collections", label: "Collections", icon: "HandCoins", permission: "expenses.read", group: "Finance", parent: "billing", available: true, phase: 3, description: "Collections and withdrawals" },
  { slug: "vouchers", href: "/vouchers", label: "Vouchers", icon: "Ticket", permission: "vouchers.read", group: "Finance", available: true, phase: 6, description: "Hotspot vouchers, batches and agents" },
  { slug: "notifications", href: "/notifications", label: "Communications", icon: "Megaphone", permission: "notifications.read", group: "Outreach", available: true, phase: 4, description: "SMS and email, templates and campaigns" },
  { slug: "reports", href: "/reports", label: "Analytics", icon: "BarChart3", permission: "reports.read", group: "Insights", available: true, phase: 5, description: "Revenue, receivables and subscriber reports" },
  { slug: "settings", href: "/settings", label: "Settings", icon: "Settings", permission: "settings.write", group: "Administration", available: true, phase: 5, description: "Organization settings" },
  { slug: "staff", href: "/staff", label: "Staff & Permissions", icon: "ShieldCheck", permission: "staff.read", group: "Administration", available: true, phase: 5, description: "Staff, roles and permissions" },
  { slug: "branches", href: "/branches", label: "Branches", icon: "Building2", permission: "branches.read", group: "Administration", available: true, phase: 5, description: "Branch management" },
  { slug: "integrations", href: "/integrations", label: "Integrations", icon: "Plug", permission: "integrations.read", group: "Administration", available: true, phase: 5, description: "Provider configuration and status" },
  { slug: "audit-logs", href: "/audit-logs", label: "Audit Logs", icon: "ScrollText", permission: "audit.read", group: "Administration", available: true, phase: 5, description: "Security and change history" },
];

export function findNavItem(slug: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.slug === slug);
}
