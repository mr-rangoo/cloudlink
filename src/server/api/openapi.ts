import "server-only";
import { z, type ZodType } from "zod";
import { loginSchema } from "@/server/auth/service";
import { signupInput, signupTokenInput } from "@/server/services/signup";
import { serviceRequestInput, setupLinkInput } from "@/server/portal/signup";
import { catalogueQuery, packageInput, packageListQuery, packageUpdate } from "@/server/services/packages";
import { noteInput, subscriberInput, subscriberListQuery, subscriberUpdate } from "@/server/services/subscribers";
import { compensateInput, subscriptionActionInput, subscriptionCreateInput, subscriptionListQuery } from "@/server/services/subscriptions";
import { leadActivityInput, leadConvertInput, leadInput, leadListQuery, leadUpdate } from "@/server/services/leads";
import { importPreviewInput } from "@/server/services/imports";
import { creditNoteInput, invoiceCreateInput, invoiceListQuery, voidInput } from "@/server/services/invoices";
import { allocateInput, manualPaymentInput, paymentListQuery, reconcileInput, refundInput, reverseInput } from "@/server/services/payments";
import { categoryInput, expenseInput, expenseListQuery, financeListQuery, reverseExpenseInput, withdrawalInput } from "@/server/services/finance";
import { commentInput, customerCommentInput, customerTicketInput, staffTicketInput, ticketListQuery, ticketUpdateInput } from "@/server/services/tickets";
import { notificationListQuery, preferencesInput, templateInput } from "@/server/services/notifications";
import { portalActivateInput, portalLoginInput } from "@/server/portal/auth";
import { reportRangeQuery } from "@/server/services/reports";
import { exportRequestInput } from "@/server/services/exports";
import { auditQuery, branchInput, branchUpdateInput, roleInput, setPasswordInput, settingsInput, staffInviteInput, staffUpdateInput } from "@/server/services/admin";
import { inventoryQuery, itemActionInput, itemInput } from "@/server/services/inventory";
import { agentInput, agentUpdateInput, batchInput, redeemInput, remittanceInput, sendVoucherInput } from "@/server/services/vouchers";
import { alertListQuery, routerInput, routerListQuery, routerUpdateInput } from "@/server/services/routers";
import { telemetryQuery } from "@/server/services/router-insights";
import { linkRouterInput } from "@/server/services/router-link";
import { deviceUpdateInput, enrolInput, tr069ListQuery } from "@/server/services/tr069";
import { servicesInput } from "@/server/domain/router-agent";
import { searchQuery } from "@/server/services/search";
import { campaignInput, sendCampaignInput } from "@/server/services/campaigns";
import { operatorAlertInput } from "@/server/services/operator-alerts";
import { emailSettingsInput, smsSettingsInput, testMessageInput } from "@/server/services/messaging-config";
import { cancelOperationInput, deprovisionInput, operationListQuery, provisionInput, routerOperationInput, sessionListQuery } from "@/server/services/network";
import { attemptListQuery, customerPaymentInput, simulateInput, stkPushInput } from "@/server/services/mobile-money";
import { mpesaConfigInput } from "@/server/services/mpesa-config";
import { activeGatewayInput, kopokopoConfigInput } from "@/server/services/payment-gateways";
import { brandingInput } from "@/server/services/branding";
import { paymentMethodInput, paymentMethodUpdate } from "@/server/services/payment-methods";
import { assistantMessageInput, assistantSettingsInput, conversationListQuery } from "@/server/assistant/service";
import { staffAskInput } from "@/server/assistant/staff";
import { c2bConfirmationSchema, stkCallbackSchema } from "@/server/domain/mpesa";
import { accessStatusInput, purchaseInput, purchaseSimulateInput, purchaseStatusInput, reconnectInput } from "@/server/services/hotspot-sales";
import { hotspotSettingsInput } from "@/server/services/hotspot-settings";

/**
 * OpenAPI 3.1 document generated from the same Zod schemas the handlers validate with.
 * Each phase registers its endpoints here; `tests/unit/openapi.test.ts` checks the document stays valid.
 */
interface Operation {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  summary: string;
  tag: string;
  auth: "session" | "none" | "webhook";
  permission?: string;
  body?: ZodType;
  query?: ZodType;
  idempotent?: boolean;
  responses?: Record<string, string>;
}

const errorEnvelope = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "correlationId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        correlationId: { type: "string" },
        fields: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
      },
    },
  },
} as const;

export const operations: Operation[] = [
  { method: "get", path: "/health/live", summary: "Liveness probe", tag: "Health", auth: "none" },
  { method: "get", path: "/health/ready", summary: "Readiness probe (database required, Redis reported)", tag: "Health", auth: "none", responses: { "503": "Not ready" } },
  { method: "post", path: "/auth/login", summary: "Staff sign-in (sets HTTP-only session cookie)", tag: "Auth", auth: "none", body: loginSchema, responses: { "401": "Invalid credentials", "429": "Rate limited" } },
  { method: "post", path: "/auth/signup", summary: "Start a new ISP workspace: emails a confirmation link (same reply whether or not the email has an account)", tag: "Auth", auth: "none", body: signupInput, responses: { "202": "Confirmation email sent", "403": "Sign-up closed", "429": "Rate limited", "503": "No mailer configured" } },
  { method: "post", path: "/auth/signup/complete", summary: "Confirm the emailed link: creates the workspace and owner, sets the session cookie", tag: "Auth", auth: "none", body: signupTokenInput, responses: { "201": "Workspace created", "409": "Link used/expired or email already registered" } },
  { method: "post", path: "/auth/logout", summary: "Revoke the current session", tag: "Auth", auth: "session" },
  { method: "get", path: "/auth/session", summary: "Current user, organization, roles, permissions and branches", tag: "Auth", auth: "session" },
  {
    method: "patch",
    path: "/auth/session",
    summary: "Switch active organization or branch filter",
    tag: "Auth",
    auth: "session",
    body: z.object({ organizationId: z.uuid().optional(), branchId: z.uuid().nullable().optional() }),
  },
  { method: "get", path: "/dashboard/summary", summary: "Database-backed KPIs (metric definitions in docs)", tag: "Dashboard", auth: "session", permission: "dashboard.view" },
  { method: "get", path: "/dashboard/activity", summary: "Recent subscriber activity", tag: "Dashboard", auth: "session", permission: "dashboard.view" },
  { method: "get", path: "/packages", summary: "List packages", tag: "Packages", auth: "session", permission: "packages.read", query: packageListQuery },
  { method: "post", path: "/packages", summary: "Create package", tag: "Packages", auth: "session", permission: "packages.write", body: packageInput },
  { method: "get", path: "/packages/:id", summary: "Get package", tag: "Packages", auth: "session", permission: "packages.read" },
  { method: "patch", path: "/packages/:id", summary: "Update package (existing subscriptions keep their snapshot; network changes are pushed to routers)", tag: "Packages", auth: "session", permission: "packages.write", body: packageUpdate },
  { method: "get", path: "/packages/catalogue", summary: "Plans with type, availability, live subscriptions and 30-day revenue, plus counts", tag: "Packages", auth: "session", permission: "packages.read", query: catalogueQuery },
  { method: "post", path: "/packages/:id/duplicate", summary: "Copy a plan (the copy starts Off)", tag: "Packages", auth: "session", permission: "packages.write", responses: { "201": "Created" } },
  { method: "post", path: "/packages/:id/sync", summary: "Push the plan's router profile (speed, burst, devices) to every router it is used on", tag: "Packages", auth: "session", permission: "packages.read + network.operate", responses: { "202": "Queued" } },
  { method: "get", path: "/subscribers", summary: "List subscribers (paginated)", tag: "Subscribers", auth: "session", permission: "subscribers.read", query: subscriberListQuery },
  { method: "post", path: "/subscribers", summary: "Create subscriber (optionally with first subscription)", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: subscriberInput, responses: { "409": "Duplicate contact" } },
  { method: "get", path: "/subscribers/:id", summary: "Get subscriber", tag: "Subscribers", auth: "session", permission: "subscribers.read" },
  { method: "patch", path: "/subscribers/:id", summary: "Update subscriber", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: subscriberUpdate },
  { method: "get", path: "/subscribers/:id/activity", summary: "Subscriber activity timeline", tag: "Subscribers", auth: "session", permission: "subscribers.read" },
  { method: "post", path: "/subscribers/:id/activity", summary: "Add a note", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: noteInput },
  { method: "post", path: "/subscribers/:id/renew", summary: "Renew the subscriber's subscription", tag: "Subscribers", auth: "session", permission: "subscriptions.write", idempotent: true },
  { method: "post", path: "/subscribers/:id/suspend", summary: "Suspend the subscriber's subscription", tag: "Subscribers", auth: "session", permission: "subscriptions.write" },
  { method: "post", path: "/subscribers/:id/reactivate", summary: "Reactivate the subscriber's subscription", tag: "Subscribers", auth: "session", permission: "subscriptions.write" },
  { method: "post", path: "/subscribers/imports", summary: "Validate a CSV and create an import preview", tag: "Subscribers", auth: "session", permission: "subscribers.import", body: importPreviewInput },
  { method: "get", path: "/subscribers/imports", summary: "Recent import jobs", tag: "Subscribers", auth: "session", permission: "subscribers.import" },
  { method: "post", path: "/subscribers/imports/:id/commit", summary: "Commit a clean preview (all rows or none)", tag: "Subscribers", auth: "session", permission: "subscribers.import" },
  { method: "get", path: "/subscriptions", summary: "List subscriptions", tag: "Subscriptions", auth: "session", permission: "subscriptions.read", query: subscriptionListQuery },
  { method: "post", path: "/subscriptions", summary: "Create subscription", tag: "Subscriptions", auth: "session", permission: "subscriptions.write", body: subscriptionCreateInput },
  { method: "get", path: "/subscriptions/:id", summary: "Get subscription with event history", tag: "Subscriptions", auth: "session", permission: "subscriptions.read" },
  ...(["activate", "renew", "suspend", "reactivate", "cancel"] as const).map((a) => ({
    method: "post" as const,
    path: `/subscriptions/:id/${a}`,
    summary: `${a.charAt(0).toUpperCase()}${a.slice(1)} subscription`,
    tag: "Subscriptions",
    auth: "session" as const,
    permission: "subscriptions.write",
    body: subscriptionActionInput,
    idempotent: a === "renew",
  })),
  { method: "post", path: "/subscriptions/:id/compensate", summary: "Add free time to the paid period (outage compensation; re-anchors billing)", tag: "Subscriptions", auth: "session", permission: "subscriptions.write", body: compensateInput, idempotent: true },
  { method: "get", path: "/leads", summary: "List leads with stage counts", tag: "CRM", auth: "session", permission: "leads.read", query: leadListQuery },
  { method: "post", path: "/leads", summary: "Create lead", tag: "CRM", auth: "session", permission: "leads.write", body: leadInput },
  { method: "get", path: "/leads/:id", summary: "Get lead with timeline", tag: "CRM", auth: "session", permission: "leads.read" },
  { method: "patch", path: "/leads/:id", summary: "Update lead / stage / owner", tag: "CRM", auth: "session", permission: "leads.write", body: leadUpdate },
  { method: "post", path: "/leads/:id/activities", summary: "Log a call, note, meeting or survey", tag: "CRM", auth: "session", permission: "leads.write", body: leadActivityInput },
  { method: "post", path: "/leads/:id/convert", summary: "Convert lead to subscriber atomically", tag: "CRM", auth: "session", permission: "leads.write + subscribers.write", body: leadConvertInput, responses: { "409": "Already converted or duplicate contact" } },
  { method: "get", path: "/invoices", summary: "List invoices (filters: UNPAID, OVERDUE, …) with outstanding total", tag: "Invoices", auth: "session", permission: "invoices.read", query: invoiceListQuery },
  { method: "post", path: "/invoices", summary: "Create a manual invoice (draft or issued)", tag: "Invoices", auth: "session", permission: "invoices.write (+ invoices.issue to issue)", body: invoiceCreateInput },
  { method: "get", path: "/invoices/:id", summary: "Invoice with lines, allocations and credit notes", tag: "Invoices", auth: "session", permission: "invoices.read" },
  { method: "delete", path: "/invoices/:id", summary: "Delete a draft invoice", tag: "Invoices", auth: "session", permission: "invoices.write" },
  { method: "post", path: "/invoices/:id/issue", summary: "Issue a draft (assigns number, posts ledger, applies credit)", tag: "Invoices", auth: "session", permission: "invoices.issue" },
  { method: "post", path: "/invoices/:id/void", summary: "Void an unpaid issued invoice (reversing ledger entry)", tag: "Invoices", auth: "session", permission: "invoices.issue", body: voidInput },
  { method: "post", path: "/invoices/:id/credit-notes", summary: "Issue a credit note (gross amount)", tag: "Invoices", auth: "session", permission: "credit_notes.create", body: creditNoteInput, idempotent: true },
  { method: "get", path: "/invoices/:id/pdf", summary: "Invoice PDF (from persisted data)", tag: "Invoices", auth: "session", permission: "invoices.read" },
  { method: "post", path: "/billing/run", summary: "Run recurring billing now (idempotent per period)", tag: "Invoices", auth: "session", permission: "invoices.issue" },
  { method: "get", path: "/payments", summary: "List payments (period, method, type, status filters; type, reconciliation and activation per row)", tag: "Payments", auth: "session", permission: "payments.read", query: paymentListQuery },
  { method: "get", path: "/payments/summary", summary: "Payment figures for a period: collected, by method and type, unmatched, credit on accounts, reversals", tag: "Payments", auth: "session", permission: "payments.read", query: paymentListQuery },
  { method: "post", path: "/payments/manual", summary: "Record a confirmed cash/bank/cheque/manual M-Pesa payment", tag: "Payments", auth: "session", permission: "payments.record", body: manualPaymentInput, idempotent: true, responses: { "409": "Duplicate reference" } },
  { method: "get", path: "/payments/unmatched", summary: "Confirmed payments not matched to a subscriber", tag: "Payments", auth: "session", permission: "payments.reconcile" },
  { method: "get", path: "/payments/:id", summary: "Payment with allocations and refunds", tag: "Payments", auth: "session", permission: "payments.read" },
  { method: "get", path: "/payments/:id/status", summary: "Server-side payment status", tag: "Payments", auth: "session", permission: "payments.read" },
  { method: "post", path: "/payments/:id/allocate", summary: "Allocate to invoices", tag: "Payments", auth: "session", permission: "payments.allocate", body: allocateInput, idempotent: true },
  { method: "post", path: "/payments/:id/allocations/:allocationId/reverse", summary: "Reverse an allocation", tag: "Payments", auth: "session", permission: "payments.reconcile", body: reverseInput },
  { method: "post", path: "/payments/:id/refunds", summary: "Refund unallocated money", tag: "Payments", auth: "session", permission: "payments.refund", body: refundInput, idempotent: true },
  { method: "post", path: "/payments/:id/reverse", summary: "Reverse a payment (bounced / entered in error)", tag: "Payments", auth: "session", permission: "payments.refund", body: reverseInput },
  { method: "post", path: "/payments/:id/reconcile", summary: "Match an unidentified payment to a subscriber", tag: "Payments", auth: "session", permission: "payments.reconcile", body: reconcileInput },
  { method: "get", path: "/payments/:id/receipt", summary: "Receipt PDF", tag: "Payments", auth: "session", permission: "payments.read" },
  { method: "get", path: "/ledger/entries", summary: "Ledger entries (double entry)", tag: "Ledger", auth: "session", permission: "ledger.read" },
  { method: "get", path: "/ledger/trial-balance", summary: "Trial balance by account", tag: "Ledger", auth: "session", permission: "ledger.read" },
  { method: "post", path: "/reconciliation/checks", summary: "Recompute cached balances and verify the ledger", tag: "Ledger", auth: "session", permission: "payments.reconcile" },
  { method: "get", path: "/expenses", summary: "List expenses (period, category, method, status, search)", tag: "Finance", auth: "session", permission: "expenses.read", query: expenseListQuery },
  { method: "get", path: "/expenses/summary", summary: "Spending for a period by category, previous period, collections and difference (payments.read)", tag: "Finance", auth: "session", permission: "expenses.read", query: expenseListQuery },
  { method: "post", path: "/expenses", summary: "Record an expense", tag: "Finance", auth: "session", permission: "expenses.write", body: expenseInput, idempotent: true },
  { method: "post", path: "/expenses/:id/reverse", summary: "Reverse an expense", tag: "Finance", auth: "session", permission: "expenses.write", body: reverseExpenseInput },
  { method: "get", path: "/expenses/categories", summary: "Expense categories", tag: "Finance", auth: "session", permission: "expenses.read" },
  { method: "post", path: "/expenses/categories", summary: "Create expense category", tag: "Finance", auth: "session", permission: "expenses.write", body: categoryInput },
  { method: "get", path: "/withdrawals", summary: "Owner drawings and bank deposits", tag: "Finance", auth: "session", permission: "expenses.read", query: financeListQuery },
  { method: "post", path: "/withdrawals", summary: "Record an owner drawing or bank deposit", tag: "Finance", auth: "session", permission: "expenses.write", body: withdrawalInput, idempotent: true },
  { method: "get", path: "/collections/summary", summary: "Monthly collections, refunds, expenses and ledger balances", tag: "Finance", auth: "session", permission: "expenses.read" },
  { method: "get", path: "/support/tickets", summary: "List support tickets", tag: "Support", auth: "session", permission: "support.read", query: ticketListQuery },
  { method: "post", path: "/support/tickets", summary: "Create a ticket", tag: "Support", auth: "session", permission: "support.write", body: staffTicketInput },
  { method: "get", path: "/support/tickets/:id", summary: "Ticket with comments (incl. internal), events, attachments", tag: "Support", auth: "session", permission: "support.read" },
  { method: "patch", path: "/support/tickets/:id", summary: "Update status / priority / assignee (RESOLVED needs a resolution)", tag: "Support", auth: "session", permission: "support.write", body: ticketUpdateInput },
  { method: "post", path: "/support/tickets/:id/comments", summary: "Reply to customer or add internal note", tag: "Support", auth: "session", permission: "support.write", body: commentInput },
  { method: "post", path: "/support/tickets/:id/attachments", summary: "Upload attachment (multipart, ≤5 MB, PNG/JPEG/WebP/PDF/text by content)", tag: "Support", auth: "session", permission: "support.write" },
  { method: "get", path: "/support/attachments/:id", summary: "Download attachment", tag: "Support", auth: "session", permission: "support.read" },
  { method: "get", path: "/notifications", summary: "Notification log", tag: "Notifications", auth: "session", permission: "notifications.read", query: notificationListQuery },
  { method: "get", path: "/notifications/templates", summary: "Templates (defaults + customised)", tag: "Notifications", auth: "session", permission: "notifications.read" },
  { method: "put", path: "/notifications/templates", summary: "Save a template", tag: "Notifications", auth: "session", permission: "notifications.write", body: templateInput },
  { method: "get", path: "/campaigns", summary: "Bulk message campaigns with delivery counts", tag: "Notifications", auth: "session", permission: "notifications.read" },
  { method: "post", path: "/campaigns", summary: "Save a draft campaign (service notice or offer) with an audience", tag: "Notifications", auth: "session", permission: "notifications.write", body: campaignInput },
  { method: "post", path: "/campaigns/preview", summary: "Audience size, recipients after preferences/consent, and a sample", tag: "Notifications", auth: "session", permission: "notifications.write", body: campaignInput },
  { method: "get", path: "/campaigns/:id", summary: "Campaign detail", tag: "Notifications", auth: "session", permission: "notifications.read" },
  { method: "patch", path: "/campaigns/:id", summary: "Edit a draft campaign", tag: "Notifications", auth: "session", permission: "notifications.write", body: campaignInput },
  { method: "post", path: "/campaigns/:id/send", summary: "Send now or at a scheduled time (once)", tag: "Notifications", auth: "session", permission: "notifications.write", body: sendCampaignInput, responses: { "202": "Queued" } },
  { method: "post", path: "/campaigns/:id/cancel", summary: "Cancel a draft/scheduled campaign or stop one being sent", tag: "Notifications", auth: "session", permission: "notifications.write" },
  { method: "get", path: "/settings/operator-alerts", summary: "Operator alert recipients, events and digest hour", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "put", path: "/settings/operator-alerts", summary: "Save operator alert recipients, events and digest hour", tag: "Settings", auth: "session", permission: "settings.write", body: operatorAlertInput },
  { method: "post", path: "/notifications/:id/retry", summary: "Retry a failed/skipped notification", tag: "Notifications", auth: "session", permission: "notifications.write" },
  { method: "get", path: "/notifications/status", summary: "Messaging adapter status", tag: "Notifications", auth: "session", permission: "notifications.read" },
  { method: "get", path: "/alerts", summary: "Items needing attention (permission-filtered)", tag: "Notifications", auth: "session" },
  { method: "get", path: "/search", summary: "Record search for the command menu (subscribers, invoices, payments, routers, tickets, leads; each by its read permission)", tag: "Dashboard", auth: "session", query: searchQuery },
  { method: "get", path: "/navigation/counts", summary: "Sidebar counts: open sessions, offline routers, open tickets, payments to match (null without permission)", tag: "Dashboard", auth: "session" },
  { method: "get", path: "/subscribers/:id/portal", summary: "Portal access status", tag: "Subscribers", auth: "session", permission: "subscribers.read" },
  { method: "post", path: "/subscribers/:id/portal", summary: "Portal access: invite | link | enable | disable", tag: "Subscribers", auth: "session", permission: "subscribers.write" },
  { method: "get", path: "/subscribers/:id/preferences", summary: "Notification preferences", tag: "Subscribers", auth: "session", permission: "subscribers.read" },
  { method: "put", path: "/subscribers/:id/preferences", summary: "Update notification preferences", tag: "Subscribers", auth: "session", permission: "subscribers.write", body: preferencesInput },
  { method: "post", path: "/customer/auth/login", summary: "Customer sign-in (phone or account number)", tag: "Customer portal", auth: "none", body: portalLoginInput, responses: { "401": "Invalid credentials", "429": "Rate limited" } },
  { method: "post", path: "/customer/auth/activate", summary: "Set password from a single-use invite token", tag: "Customer portal", auth: "none", body: portalActivateInput },
  { method: "post", path: "/customer/auth/setup-link", summary: "Send a portal setup/password link to the contacts on file (generic reply)", tag: "Customer portal", auth: "none", body: setupLinkInput, responses: { "202": "Requested", "429": "Rate limited" } },
  { method: "post", path: "/customer/signup", summary: "Prospective customer requests a connection (becomes a lead)", tag: "Customer portal", auth: "none", body: serviceRequestInput, responses: { "202": "Received", "429": "Rate limited" } },
  { method: "post", path: "/customer/auth/logout", summary: "Customer sign-out", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/me", summary: "Own profile, service, balance, open invoices, recent payments", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/connection", summary: "Own internet connection status from the latest session sync (online/offline, uptime, current-session data, freshness)", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/invoices", summary: "Own invoices", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/invoices/:id", summary: "Own invoice (404 for anyone else's)", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/invoices/:id/pdf", summary: "Own invoice PDF", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/payments", summary: "Own payments", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/receipts/:id", summary: "Own receipt PDF", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/tickets", summary: "Own tickets", tag: "Customer portal", auth: "session" },
  { method: "post", path: "/customer/tickets", summary: "Open a ticket", tag: "Customer portal", auth: "session", body: customerTicketInput },
  { method: "get", path: "/customer/tickets/:id", summary: "Own ticket (no internal notes)", tag: "Customer portal", auth: "session" },
  { method: "post", path: "/customer/tickets/:id/comments", summary: "Reply (reopens resolved tickets)", tag: "Customer portal", auth: "session", body: customerCommentInput },
  { method: "post", path: "/customer/tickets/:id/attachments", summary: "Upload attachment to own ticket", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/attachments/:id", summary: "Download attachment from own ticket", tag: "Customer portal", auth: "session" },
  { method: "get", path: "/customer/preferences", summary: "Own notification preferences", tag: "Customer portal", auth: "session" },
  { method: "put", path: "/customer/preferences", summary: "Update own notification preferences", tag: "Customer portal", auth: "session", body: preferencesInput },
  { method: "get", path: "/reports/revenue", summary: "Revenue, credit notes, tax, collections and expenses by month (from the ledger)", tag: "Reports", auth: "session", permission: "reports.read", query: reportRangeQuery },
  { method: "get", path: "/reports/receivables", summary: "Receivables aging by subscriber", tag: "Reports", auth: "session", permission: "reports.read" },
  { method: "get", path: "/reports/subscribers", summary: "Subscriber growth and lifecycle events by month; active by package", tag: "Reports", auth: "session", permission: "reports.read", query: reportRangeQuery },
  { method: "get", path: "/reports/collections", summary: "Confirmed collections by method and month", tag: "Reports", auth: "session", permission: "reports.read", query: reportRangeQuery },
  { method: "get", path: "/exports", summary: "Recent export jobs", tag: "Reports", auth: "session", permission: "reports.export" },
  { method: "post", path: "/exports", summary: "Queue a CSV export (202)", tag: "Reports", auth: "session", permission: "reports.export + read access to the data", body: exportRequestInput, responses: { "202": "Queued" } },
  { method: "get", path: "/exports/:id/download", summary: "Download a ready export (valid 24 h; audited)", tag: "Reports", auth: "session", permission: "reports.export" },
  { method: "get", path: "/staff", summary: "Staff members of this organization", tag: "Administration", auth: "session", permission: "staff.read" },
  { method: "post", path: "/staff", summary: "Invite staff (returns a one-time setup link for new users)", tag: "Administration", auth: "session", permission: "staff.write", body: staffInviteInput },
  { method: "patch", path: "/staff/:id", summary: "Update roles, branch scope or status (revokes sessions)", tag: "Administration", auth: "session", permission: "staff.write", body: staffUpdateInput },
  { method: "post", path: "/staff/:id/reset-link", summary: "One-time password reset link", tag: "Administration", auth: "session", permission: "staff.write" },
  { method: "post", path: "/auth/invite", summary: "Complete a staff setup/reset link", tag: "Auth", auth: "none", body: setPasswordInput },
  { method: "get", path: "/roles", summary: "Roles and the permission catalogue", tag: "Administration", auth: "session", permission: "staff.read" },
  { method: "post", path: "/roles", summary: "Create a custom role", tag: "Administration", auth: "session", permission: "roles.write", body: roleInput },
  { method: "patch", path: "/roles/:id", summary: "Edit a role (owner role is locked)", tag: "Administration", auth: "session", permission: "roles.write", body: roleInput },
  { method: "delete", path: "/roles/:id", summary: "Delete an unused custom role", tag: "Administration", auth: "session", permission: "roles.write" },
  { method: "get", path: "/branches", summary: "Branches with subscriber counts", tag: "Administration", auth: "session", permission: "branches.read" },
  { method: "post", path: "/branches", summary: "Create a branch", tag: "Administration", auth: "session", permission: "branches.write", body: branchInput },
  { method: "patch", path: "/branches/:id", summary: "Update or archive a branch", tag: "Administration", auth: "session", permission: "branches.write", body: branchUpdateInput },
  { method: "get", path: "/settings", summary: "Organization and billing settings", tag: "Administration", auth: "session", permission: "settings.write" },
  { method: "patch", path: "/settings", summary: "Update organization and billing settings", tag: "Administration", auth: "session", permission: "settings.write", body: settingsInput },
  { method: "get", path: "/audit-logs", summary: "Search the audit log", tag: "Administration", auth: "session", permission: "audit.read", query: auditQuery },
  { method: "get", path: "/inventory", summary: "Equipment inventory", tag: "Inventory", auth: "session", permission: "inventory.read", query: inventoryQuery },
  { method: "post", path: "/inventory", summary: "Add equipment", tag: "Inventory", auth: "session", permission: "inventory.write", body: itemInput },
  { method: "get", path: "/inventory/:id", summary: "Item with movement history", tag: "Inventory", auth: "session", permission: "inventory.read" },
  { method: "post", path: "/inventory/:id/actions", summary: "assign | return | mark_faulty | repaired | retire", tag: "Inventory", auth: "session", permission: "inventory.write", body: itemActionInput },
  { method: "get", path: "/integrations", summary: "Integration status (no secrets)", tag: "Administration", auth: "session", permission: "integrations.read" },
  { method: "get", path: "/vouchers", summary: "Redemption statistics (30 days) and activation outcomes", tag: "Vouchers", auth: "session", permission: "vouchers.read" },
  { method: "get", path: "/vouchers/batches", summary: "Voucher batches", tag: "Vouchers", auth: "session", permission: "vouchers.read" },
  { method: "post", path: "/vouchers/batches", summary: "Generate a batch (plaintext codes returned once)", tag: "Vouchers", auth: "session", permission: "vouchers.write", body: batchInput, idempotent: true },
  { method: "get", path: "/vouchers/batches/:id", summary: "Batch with voucher statuses (code hints only)", tag: "Vouchers", auth: "session", permission: "vouchers.read" },
  { method: "post", path: "/vouchers/batches/:id/void", summary: "Void unused vouchers in a batch", tag: "Vouchers", auth: "session", permission: "vouchers.write" },
  { method: "get", path: "/vouchers/batches/:id/export", summary: "Audited export of unused codes (PDF cards, or ?format=csv)", tag: "Vouchers", auth: "session", permission: "vouchers.export" },
  { method: "post", path: "/vouchers/:id/send", summary: "Text an unused voucher code to a phone (audited; code not stored in the message)", tag: "Vouchers", auth: "session", permission: "vouchers.export", body: sendVoucherInput, responses: { "202": "Queued" } },
  { method: "post", path: "/vouchers/redeem", summary: "Staff-assisted redemption", tag: "Vouchers", auth: "session", permission: "vouchers.write", body: redeemInput },
  { method: "get", path: "/agents", summary: "Agents with sold/commission/remitted/owed", tag: "Vouchers", auth: "session", permission: "vouchers.read" },
  { method: "post", path: "/agents", summary: "Create agent", tag: "Vouchers", auth: "session", permission: "vouchers.write", body: agentInput },
  { method: "patch", path: "/agents/:id", summary: "Update agent", tag: "Vouchers", auth: "session", permission: "vouchers.write", body: agentUpdateInput },
  { method: "post", path: "/agents/:id/remittances", summary: "Record cash received from an agent (≤ owed)", tag: "Vouchers", auth: "session", permission: "payments.record", body: remittanceInput, idempotent: true },
  { method: "post", path: "/hotspot/:org/redeem", summary: "Captive-portal redemption (public, rate-limited, same-origin)", tag: "Hotspot", auth: "none", body: redeemInput, responses: { "409": "Already used", "429": "Rate limited" } },
  { method: "post", path: "/hotspot/:org/status", summary: "Activation status (requires the voucher code)", tag: "Hotspot", auth: "none" },
  { method: "get", path: "/hotspot/:org/plans", summary: "Live hotspot plans with the price the customer pays (optionally ?router=)", tag: "Hotspot", auth: "none" },
  { method: "post", path: "/hotspot/:org/purchase", summary: "Buy a plan with M-Pesa (STK Push) or claim a free trial; returns a purchase token", tag: "Hotspot", auth: "none", body: purchaseInput, responses: { "201": "Request sent", "409": "Trial already used", "429": "Rate limited" } },
  { method: "post", path: "/hotspot/:org/purchase/status", summary: "Purchase progress; login details once the payment is confirmed (token holder only)", tag: "Hotspot", auth: "none", body: purchaseStatusInput },
  { method: "post", path: "/hotspot/:org/purchase/simulate", summary: "Test mode only: simulate the customer's M-Pesa response", tag: "Hotspot", auth: "none", body: purchaseSimulateInput },
  { method: "post", path: "/hotspot/:org/access", summary: "Whether the router is ready for the login the caller holds", tag: "Hotspot", auth: "none", body: accessStatusInput },
  { method: "post", path: "/hotspot/:org/reconnect", summary: "Already paid: M-Pesa code + paying phone returns the login details again", tag: "Hotspot", auth: "none", body: reconnectInput, responses: { "404": "No active plan for that code and phone" } },
  { method: "get", path: "/hotspot-files/:routerId/login.html", summary: "Router hotspot login page (redirects to the captive portal)", tag: "Hotspot", auth: "none", responses: { "200": "text/html" } },
  // Phase 7: routers, network operations, sessions, RADIUS-backed provisioning
  { method: "get", path: "/routers", summary: "Router inventory with status, sessions and open alerts", tag: "Network", auth: "session", permission: "routers.read", query: routerListQuery },
  { method: "post", path: "/routers", summary: "Register a router (private/VPN IP only; credentials write-only, encrypted)", tag: "Network", auth: "session", permission: "routers.write", body: routerInput },
  { method: "get", path: "/routers/:id", summary: "Router detail (never includes credentials)", tag: "Network", auth: "session", permission: "routers.read" },
  { method: "patch", path: "/routers/:id", summary: "Edit a router; send username+password to rotate credentials", tag: "Network", auth: "session", permission: "routers.write", body: routerUpdateInput },
  { method: "post", path: "/routers/:id/setup-command", summary: "One-time router setup command (30 min, single use; response never stored)", tag: "Network", auth: "session", permission: "routers.write" },
  { method: "post", path: "/routers/link", summary: "Link a MikroTik, step 1: create the router (no address or credentials yet)", tag: "Network", auth: "session", permission: "routers.write", body: linkRouterInput, responses: { "201": "Created" } },
  { method: "get", path: "/routers/:id/link", summary: "Link wizard state: agent check-ins, reported ports, saved services, latest change", tag: "Network", auth: "session", permission: "routers.read" },
  { method: "put", path: "/routers/:id/services", summary: "Link a MikroTik, step 3: hotspot/PPPoE, ports, devices per login, sharing block (applied by the router on its next check-in)", tag: "Network", auth: "session", permission: "routers.write", body: servicesInput },
  { method: "post", path: "/routers/:id/simulate", summary: "Test mode only: a simulated router checks in and confirms pending changes", tag: "Network", auth: "session", permission: "routers.write", responses: { "403": "Not in test mode" } },
  { method: "post", path: "/routers/agent/:key", summary: "Router agent check-in (every minute); answers with a RouterOS script to import. The per-router key is the authorization", tag: "Network", auth: "none", responses: { "200": "RouterOS script (text/plain)", "404": "Unknown key" } },
  { method: "post", path: "/routers/agent/:key/result", summary: "Router confirms or reports failure of a change it imported", tag: "Network", auth: "none", responses: { "200": "Recorded" } },
  { method: "get", path: "/tr069/devices", summary: "TR-069 devices with check-in state and signal; counts and the ACS address", tag: "Network", auth: "session", permission: "inventory.read", query: tr069ListQuery },
  { method: "post", path: "/tr069/devices", summary: "Enrol a TR-069 device by serial number", tag: "Network", auth: "session", permission: "inventory.write", body: enrolInput, responses: { "201": "Enrolled", "409": "Already enrolled" } },
  { method: "patch", path: "/tr069/devices/:id", summary: "Change a TR-069 device label or subscriber", tag: "Network", auth: "session", permission: "inventory.write", body: deviceUpdateInput },
  { method: "delete", path: "/tr069/devices/:id", summary: "Remove a TR-069 device from Cloudlink", tag: "Network", auth: "session", permission: "inventory.write" },
  { method: "post", path: "/tr069/sync", summary: "Read the devices from the ACS now (worker)", tag: "Network", auth: "session", permission: "inventory.read", responses: { "202": "Queued" } },
  { method: "get", path: "/tr069/firmware", summary: "Firmware versions by model", tag: "Network", auth: "session", permission: "inventory.read" },
  { method: "get", path: "/routers/setup/:token", summary: "Router downloads its setup script (.rsc); the single-use token is the authorization", tag: "Network", auth: "none", responses: { "200": "RouterOS script (text/plain)", "404": "Invalid, expired or used" } },
  { method: "post", path: "/routers/:id/archive", summary: "Archive a router (refused while subscriptions are provisioned on it)", tag: "Network", auth: "session", permission: "routers.write" },
  { method: "post", path: "/routers/:id/health-check", summary: "Queue a reachability check (runs in the worker)", tag: "Network", auth: "session", permission: "network.operate", responses: { "202": "Queued" } },
  { method: "post", path: "/routers/:id/sync-plans", summary: "Push every plan this router uses as a router profile", tag: "Network", auth: "session", permission: "network.operate", responses: { "202": "Queued" } },
  { method: "get", path: "/routers/:id/telemetry", summary: "Health score, resource/traffic series, 7-day reachability heatmap and outages (from health checks)", tag: "Network", auth: "session", permission: "routers.read", query: telemetryQuery },
  { method: "get", path: "/routers/:id/snapshots", summary: "Latest fetched router logs and diagnosis checks", tag: "Network", auth: "session", permission: "network.read" },
  { method: "get", path: "/routers/:id/report", summary: "Router reports: collections (payments.read only), sessions, peak hours, subscriptions by status", tag: "Network", auth: "session", permission: "routers.read" },
  { method: "get", path: "/routers/:id/sessions", summary: "Sessions seen on one router", tag: "Network", auth: "session", permission: "network.read", query: sessionListQuery.omit({ routerId: true }) },
  { method: "post", path: "/routers/:id/operations", summary: "Request an allowlisted operation: pppoe.sync, session.disconnect, router.diagnose, router.logs; with routers.write also router.reboot, router.identity, router.clock, hotspot.walled_garden, hotspot.login_page", tag: "Network", auth: "session", permission: "network.operate", body: routerOperationInput, responses: { "202": "Queued" } },
  { method: "get", path: "/network/operations", summary: "Durable network operations (status, attempts, verification)", tag: "Network", auth: "session", permission: "network.read", query: operationListQuery },
  { method: "get", path: "/network/operations/:id", summary: "Operation with its append-only attempt log and alerts", tag: "Network", auth: "session", permission: "network.read" },
  { method: "post", path: "/network/operations/:id/retry", summary: "Re-queue a failed operation", tag: "Network", auth: "session", permission: "network.operate", responses: { "202": "Queued" } },
  { method: "post", path: "/network/operations/:id/cancel", summary: "Cancel a queued or retrying operation", tag: "Network", auth: "session", permission: "network.operate", body: cancelOperationInput },
  { method: "get", path: "/network/alerts", summary: "Router offline / operation failed / operation stuck alerts", tag: "Network", auth: "session", permission: "network.read", query: alertListQuery },
  { method: "post", path: "/network/alerts/:id/resolve", summary: "Resolve an alert", tag: "Network", auth: "session", permission: "network.operate" },
  { method: "get", path: "/network/sessions", summary: "PPPoE/Hotspot sessions (router API, RADIUS accounting, or simulated in test mode) with online counts", tag: "Network", auth: "session", permission: "network.read", query: sessionListQuery },
  { method: "post", path: "/network/sessions", summary: "Queue a session sync from every router (de-duplicated per 30 s; used by live view)", tag: "Network", auth: "session", permission: "network.read", responses: { "202": "Queued" } },
  { method: "get", path: "/subscriptions/:id/network", summary: "Network access state (separate from billing status)", tag: "Network", auth: "session", permission: "network.read" },
  { method: "post", path: "/subscriptions/:id/network", summary: "Provision or move PPPoE access (queues an operation)", tag: "Network", auth: "session", permission: "network.operate", body: provisionInput, responses: { "202": "Queued" } },
  { method: "post", path: "/subscriptions/:id/network/credentials", summary: "Reveal PPPoE credentials (audited, never cached or stored)", tag: "Network", auth: "session", permission: "network.operate" },
  { method: "post", path: "/subscriptions/:id/network/deprovision", summary: "Remove network access and stored credentials", tag: "Network", auth: "session", permission: "network.operate", body: deprovisionInput, responses: { "202": "Queued" } },
  // Phase 10: branding and customer payment methods
  { method: "get", path: "/settings/branding", summary: "Theme, brand colour, default appearance, logo and portal texts", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "put", path: "/settings/branding", summary: "Save branding (brand colour is contrast-checked)", tag: "Settings", auth: "session", permission: "settings.write", body: brandingInput },
  { method: "post", path: "/settings/branding/logo", summary: "Upload the logo (multipart file; PNG/JPEG/WebP, 512 KB)", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "delete", path: "/settings/branding/logo", summary: "Remove the logo", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "get", path: "/branding/:slug/logo", summary: "Public organization logo", tag: "Settings", auth: "none" },
  { method: "get", path: "/settings/payment-methods", summary: "Ways customers can pay", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "post", path: "/settings/payment-methods", summary: "Add a payment method (paybill, till, bank, cash, other)", tag: "Settings", auth: "session", permission: "settings.write", body: paymentMethodInput },
  { method: "put", path: "/settings/payment-methods/:id", summary: "Replace a payment method", tag: "Settings", auth: "session", permission: "settings.write", body: paymentMethodInput },
  { method: "patch", path: "/settings/payment-methods/:id", summary: "Show/hide or reorder", tag: "Settings", auth: "session", permission: "settings.write", body: paymentMethodUpdate },
  { method: "delete", path: "/settings/payment-methods/:id", summary: "Remove a payment method", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "get", path: "/settings/hotspot", summary: "Captive portal settings", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "put", path: "/settings/hotspot", summary: "Save the captive portal template, headline, how-to-buy steps, support contacts and tabs", tag: "Settings", auth: "session", permission: "settings.write", body: hotspotSettingsInput },
  // Phase 10: customer-portal AI assistant
  { method: "get", path: "/settings/assistant", summary: "Assistant settings and deployment status (adapter, model; no secrets)", tag: "Settings", auth: "session", permission: "settings.write" },
  { method: "put", path: "/settings/assistant", summary: "Turn the portal assistant on/off, name it, add organization guidance", tag: "Settings", auth: "session", permission: "settings.write", body: assistantSettingsInput },
  { method: "post", path: "/assistant/ask", summary: "Ask AI (staff): a question answered from records the asking user may see; read-only tools, text-only history", tag: "Support", auth: "session", permission: "dashboard.view", body: staffAskInput, responses: { "429": "Too many questions", "503": "Assistant not set up" } },
  { method: "get", path: "/assistant/conversations", summary: "Customer chats with the assistant (branch-scoped)", tag: "Support", auth: "session", permission: "support.read", query: conversationListQuery },
  { method: "get", path: "/assistant/conversations/:id", summary: "Chat transcript with the tools the assistant used (results summarised)", tag: "Support", auth: "session", permission: "support.read" },
  { method: "get", path: "/customer/assistant", summary: "Whether the assistant is available, its name, and the open chat", tag: "Customer portal", auth: "session" },
  { method: "post", path: "/customer/assistant/messages", summary: "Ask the assistant; it may look up only this customer's records or open one ticket per chat (rate-limited)", tag: "Customer portal", auth: "session", body: assistantMessageInput, responses: { "429": "Too many messages", "503": "Assistant unavailable" } },
  { method: "post", path: "/customer/assistant/end", summary: "End the open chat", tag: "Customer portal", auth: "session" },
  // Phase 8: M-Pesa (Daraja) payment requests, callbacks and configuration
  { method: "post", path: "/payments/mpesa/stk-push", summary: "Prompt a subscriber's phone to pay (STK Push); money is recorded only on a verified callback", tag: "Payments", auth: "session", permission: "payments.initiate", body: stkPushInput, idempotent: true, responses: { "202": "Request sent", "503": "M-Pesa not configured" } },
  { method: "get", path: "/payments/attempts", summary: "M-Pesa payment requests and outcomes", tag: "Payments", auth: "session", permission: "payments.read", query: attemptListQuery },
  { method: "get", path: "/payments/attempts/:id", summary: "Payment request with its (minimised) provider callbacks", tag: "Payments", auth: "session", permission: "payments.read" },
  { method: "post", path: "/payments/attempts/:id/query", summary: "Ask M-Pesa for the current state now (worker)", tag: "Payments", auth: "session", permission: "payments.initiate", responses: { "202": "Queued" } },
  { method: "post", path: "/payments/attempts/:id/simulate", summary: "Development only (mock adapter): simulate the customer's response", tag: "Payments", auth: "session", permission: "payments.initiate", body: simulateInput },
  { method: "get", path: "/integrations/mpesa", summary: "M-Pesa settings (credentials never returned)", tag: "Integrations", auth: "session", permission: "integrations.read" },
  { method: "put", path: "/integrations/mpesa", summary: "Save M-Pesa settings and encrypted credentials", tag: "Integrations", auth: "session", permission: "integrations.write", body: mpesaConfigInput },
  { method: "get", path: "/integrations/messaging", summary: "SMS and email provider settings and the provider in use (credentials never returned)", tag: "Integrations", auth: "session", permission: "integrations.read" },
  { method: "put", path: "/integrations/messaging/sms", summary: "Save the SMS provider (Africa's Talking or Twilio); credentials encrypted, write-only", tag: "Integrations", auth: "session", permission: "integrations.write", body: smsSettingsInput },
  { method: "put", path: "/integrations/messaging/email", summary: "Save the SMTP server; password encrypted, write-only", tag: "Integrations", auth: "session", permission: "integrations.write", body: emailSettingsInput },
  { method: "post", path: "/integrations/messaging/test", summary: "Send a test SMS/email now; records whether the provider accepted it", tag: "Integrations", auth: "session", permission: "integrations.write", body: testMessageInput },
  { method: "post", path: "/integrations/messaging/confirm", summary: "Confirm the last accepted test arrived (marks the provider verified)", tag: "Integrations", auth: "session", permission: "integrations.write" },
  { method: "post", path: "/integrations/messaging/balance", summary: "Ask the SMS provider for its prepaid balance", tag: "Integrations", auth: "session", permission: "integrations.read" },
  { method: "post", path: "/integrations/mpesa/test", summary: "Check credentials (OAuth token only; no money moves)", tag: "Integrations", auth: "session", permission: "integrations.write" },
  // Phase 18: payment gateway catalogue
  { method: "get", path: "/integrations/payment-gateways", summary: "Gateway catalogue: configuration status and which gateway collects online payments", tag: "Integrations", auth: "session", permission: "integrations.read" },
  { method: "put", path: "/integrations/payment-gateways/active", summary: "Choose the gateway for new online payments (must be configured)", tag: "Integrations", auth: "session", permission: "integrations.write", body: activeGatewayInput },
  { method: "put", path: "/integrations/kopokopo", summary: "Save Kopo Kopo settings (credentials write-only, encrypted)", tag: "Integrations", auth: "session", permission: "integrations.write", body: kopokopoConfigInput },
  { method: "post", path: "/integrations/kopokopo/test", summary: "Check Kopo Kopo credentials (token only; no money moves)", tag: "Integrations", auth: "session", permission: "integrations.write" },
  { method: "post", path: "/integrations/mpesa/register-c2b", summary: "Register C2B confirmation/validation URLs", tag: "Integrations", auth: "session", permission: "integrations.write" },
  { method: "post", path: "/customer/payments", summary: "Customer pays with M-Pesa (own account or invoice)", tag: "Customer portal", auth: "session", body: customerPaymentInput, responses: { "202": "Request sent" } },
  { method: "get", path: "/customer/payments/attempts/:id", summary: "Status of the customer's own payment request", tag: "Customer portal", auth: "session" },
  { method: "post", path: "/webhooks/mobile-money/stk/:token", summary: "M-Pesa STK result callback (secret per-request token; verified with an STK query)", tag: "Webhooks", auth: "webhook", body: stkCallbackSchema, responses: { "200": "Acknowledged (also for duplicates)", "404": "Unknown token" } },
  { method: "post", path: "/webhooks/mobile-money/kopokopo/:token", summary: "Kopo Kopo incoming-payment result (secret per-request token + X-KopoKopo-Signature; verified with a status query)", tag: "Webhooks", auth: "webhook", responses: { "200": "Acknowledged (also for duplicates)", "401": "Missing or invalid signature", "404": "Unknown token" } },
  { method: "post", path: "/webhooks/mobile-money/c2b/:token/confirmation", summary: "M-Pesa C2B confirmation (secret per-organization token)", tag: "Webhooks", auth: "webhook", body: c2bConfirmationSchema, responses: { "200": "Acknowledged" } },
  { method: "post", path: "/webhooks/mobile-money/c2b/:token/validation", summary: "M-Pesa C2B validation", tag: "Webhooks", auth: "webhook", body: c2bConfirmationSchema, responses: { "200": "Accepted or rejected (ResultCode)" } },
];

/** Register additional operations (called by feature modules at import time). */
export function registerOperations(ops: Operation[]): void {
  for (const op of ops) {
    if (!operations.some((o) => o.method === op.method && o.path === op.path)) operations.push(op);
  }
}

function jsonSchema(schema: ZodType) {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
}

export function buildOpenApiDocument(serverUrl = "/api/v1") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const oasPath = op.path.replace(/:(\w+)/g, "{$1}");
    const params = [...op.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    if (op.idempotent) params.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } });
    if (op.query) {
      const qs = jsonSchema(op.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(qs.properties ?? {})) {
        params.push({ name, in: "query", required: qs.required?.includes(name) ?? false, schema: schema as { type: string } });
      }
    }
    const responses: Record<string, unknown> = {
      "200": { description: "Success" },
      ...(op.auth === "session" ? { "401": { description: "Not authenticated" }, "403": { description: "Forbidden" } } : {}),
      "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    };
    for (const [code, description] of Object.entries(op.responses ?? {})) responses[code] = { description };

    paths[oasPath] ??= {};
    paths[oasPath][op.method] = {
      summary: op.summary,
      tags: [op.tag],
      ...(op.permission ? { description: `Requires permission \`${op.permission}\`.` } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } } } : {}),
      ...(op.auth === "session" ? { security: [{ session: [] }] } : { security: [] }),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Cloudlink API", version: "1.0.0", description: "ISP billing, payments and network operations API. All money values are decimal strings with an explicit currency." },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { session: { type: "apiKey", in: "cookie", name: "cloudlink_session", description: "Staff session cookie. Customer-portal endpoints use the cloudlink_portal cookie instead." } },
      schemas: { Error: errorEnvelope },
    },
    paths,
  };
}
