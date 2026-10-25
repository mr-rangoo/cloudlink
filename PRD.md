# Cloudlink — Product Requirements Document (PRD)

## 1. Product summary
Cloudlink is a multi-tenant ISP business and network operations platform. It centralizes customer lifecycle management, subscription billing, payment collection, network access workflows, support, and reporting.

## 2. Goals
- Reduce manual subscriber and billing administration.
- Generate accurate recurring invoices.
- Reconcile M-Pesa and manual/bank payments.
- Automate subscription-related network operations safely.
- Provide customer self-service.
- Give owners and staff role-appropriate operational visibility.
- Maintain auditable financial and network records.

## 3. Non-goals for initial release
- Replacing every ISP vendor system.
- Universal compatibility with every RouterOS version or RADIUS deployment.
- Claiming regulatory compliance without review.
- Storing payment card security codes or M-Pesa PINs.
- Allowing arbitrary remote router CLI commands.
- Production payment acceptance before provider approval and verification.

## 4. User roles
- Owner: organization-wide configuration and oversight.
- Administrator: operational configuration and staff management within permissions.
- Accountant: invoices, payments, reconciliation, credits, refunds, expenses and reports.
- Cashier: authorized payment entry and receipts.
- Network technician: router inventory, sessions, alerts and approved network operations.
- Support agent: customer profiles, tickets and permitted communication.
- Sales agent: leads, subscriber onboarding and assigned sales workflows.
- Customer: own subscription, invoices, payments, receipts, profile and tickets only.

Roles are defaults. Enforce configurable permissions server-side.

## 5. Major modules
1. Dashboard and alerts.
2. CRM/leads.
3. Subscribers and contacts.
4. Packages and pricing.
5. Subscription lifecycle.
6. Invoices and billing schedules.
7. Payments, allocations and reconciliation.
8. Expenses, collections and withdrawals.
9. Hotspot vouchers and captive portal.
10. Routers, PPPoE, Hotspot, sessions and RADIUS.
11. Customer portal.
12. Support tickets.
13. Email/SMS and optional WhatsApp provider adapters.
14. Reports and exports.
15. Staff, permissions, organizations and branches.
16. Equipment inventory.
17. Integration configuration.
18. Audit logs and settings.

## 6. Core business rules
- Every subscriber belongs to an organization and may belong to a branch.
- Every subscription references a package and preserves relevant commercial terms.
- Issued invoice lines are historical snapshots.
- Invoice generation is idempotent per subscription and billing period.
- Payment confirmation must be verified; redirects are not proof.
- Payment allocation cannot exceed the available valid payment amount.
- Duplicate webhooks must not duplicate payment, allocation, renewal or network action.
- Refunds and corrections are auditable.
- Customer users can only access their own records.
- Billing state and network state are separate.
- A network action is successful only when its adapter reports success and, where supported, state is verified.
- Demo mode is disabled in production.

## 7. Dashboard KPIs
Display actual database-backed counts and totals for subscribers, active/suspended/expired subscriptions, invoices, payments, receivables, collections, expenses, recurring revenue, payment exceptions, router status, network operations and support workload. Define each metric consistently and disclose when data is unavailable.

## 8. Functional acceptance
- Create and edit a lead and convert it without losing history.
- Create a package and subscriber, then activate a subscription.
- Generate an invoice once for a billing period.
- Record and allocate a partial or full manual payment.
- Process an idempotent M-Pesa sandbox callback.
- Show unmatched payments for authorized review.
- Generate and download an invoice/receipt.
- View the customer portal without cross-account leakage.
- Queue and audit a network operation through a mock adapter.
- Produce reports consistent with ledger records.
- Export permitted data with audit logging.
- Demonstrate tenant isolation with at least two test organizations.

## 9. Non-functional requirements
- Responsive, accessible interface.
- Strong authorization and tenant isolation.
- Transactional financial operations.
- Reliable background job handling.
- Structured observability.
- Automated tests and reproducible setup.
- Backup and restore documentation.
- Clear distinction between mock, sandbox-tested and production-verified integrations.
