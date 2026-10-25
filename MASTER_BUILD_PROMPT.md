# Cloudlink — Master Build Prompt

## Role
Act as principal software architect, full-stack engineer, database engineer, security engineer, UI/UX designer, QA engineer, and deployment engineer.

Build **Cloudlink**, a production-oriented ISP billing, subscriber management, payment collection, and network automation platform for the Kenyan market.

Do not merely return recommendations. Inspect and implement directly in the repository. Read `AGENTS.md` and all project specification files before making architectural decisions.

## Objective
Implement the lifecycle:

Lead → Subscriber → Package → Subscription → Invoice → Payment → Reconciliation → Renewal → Network Access Operation → Notification → Reporting.

The system must be original in branding and implementation. Do not copy proprietary source code, private APIs, protected assets, or exact branded interface designs from other services.

## Architecture
Use a modular monolith with:
- Next.js web application and server-side API.
- Domain/service modules separated from UI and persistence.
- PostgreSQL with Prisma migrations.
- Redis and BullMQ for a separately runnable worker.
- Secure server-side integration adapters.
- Object storage adapter for generated documents and uploads.
- OpenAPI documentation.
- Structured logs, health/readiness endpoints, correlation IDs, and graceful shutdown.

Prefer the stack in `TRD.md`. Avoid microservices unless a demonstrated need justifies them.

## Read first
- `AGENTS.md`
- `PRD.md`
- `TRD.md`
- `DATABASE.md`
- `API_SPEC.md`
- `APP_FLOW.md`
- `UI_UX_GUIDE.md`
- `INTEGRATIONS.md`
- `SECURITY.md`
- `TESTING.md`
- `DEPLOYMENT.md`
- `IMPLEMENTATION_PLAN.md`

## Build requirements
Implement all major modules: dashboard, CRM/leads, subscribers, packages, subscriptions, invoices, payments, ledger/reconciliation, expenses/withdrawals, vouchers, routers, network sessions, RADIUS integration, support tickets, notifications, customer portal, reports, staff/roles/permissions, branches, inventory, integrations, audit logs, and settings.

Every major module must have working persistence and validated workflows. If a module depends on unavailable hardware or credentials, implement its adapter interface and safe development mock, and clearly mark the actual integration status.

## Financial correctness
- Use PostgreSQL numeric/Prisma Decimal for money.
- Use transactions for financial mutations.
- Store immutable invoice line snapshots.
- Make invoice generation unique per subscription and billing period.
- Implement payment state transitions and payment allocations.
- Enforce provider transaction uniqueness and idempotent callback processing.
- Use reversals and credit notes instead of silently overwriting issued financial records.
- Do not renew a subscription twice on duplicate callbacks.
- A client redirect must never prove payment.
- Reconcile balances from valid financial records using a documented rule.

## Network correctness
- Implement RouterOS, PPPoE, Hotspot, and RADIUS adapters server-side.
- Keep router management private via VPN/private connectivity/allowlists.
- Encrypt stored credentials and redact them from logs.
- Use allowlisted operations; never accept arbitrary router commands from clients.
- Record network operations durably, queue them, retry eligible transient failures, and record the real result.
- Keep payment/subscription state separate from network operation state.
- Do not report a reconnection as successful until verified where the adapter supports verification.

## Security
Enforce secure sessions, server-side authorization, tenant/branch isolation, request validation, rate limiting, webhook authenticity checks where supported, replay protection, audit logging, secure cookies, production HTTPS, secure secret handling, and data minimization. Read `SECURITY.md`.

## UI
Use Cloudlink's original design system in `UI_UX_GUIDE.md`. Every visible action must work or clearly indicate unavailability. Use real data; label demo data. Implement responsive, accessible interfaces and loading/error/empty states.

## Execution process
1. Inspect workspace and report concise findings in `IMPLEMENTATION_PLAN.md`.
2. Establish app shell, design system, database, migrations, authentication, tenant scope, and test harness.
3. Build a working subscriber/package/subscription vertical slice.
4. Add billing and payment ledger.
5. Add customer portal and support.
6. Add reports and operational modules.
7. Add voucher/captive portal workflows.
8. Add M-Pesa sandbox integration.
9. Add MikroTik/RADIUS adapters and test against a device only when available.
10. Prepare cloud deployment and run the complete test suite.

After every phase:
- Run lint, typecheck, relevant tests, and build.
- Fix failures before moving forward.
- Update `IMPLEMENTATION_PLAN.md`.
- Record actual results and remaining blockers.

## Definition of done
Cloudlink is not complete until:
- Clean setup is documented and works.
- Migrations and seed scripts work.
- Auth and server-side permissions work.
- Core records persist across restart.
- Subscriber/package/subscription workflows work.
- Invoice calculations and scheduled generation are correct and idempotent.
- Payment allocations and duplicate callback protection work.
- Customer data is isolated.
- Receipts and reports use persisted data.
- Mock integrations work end to end.
- Real integration status is accurately documented.
- Automated tests and production build pass.
- Deployment, backup, restore, and rollback instructions exist.

Begin now by inspecting the repository and implementing Phase 1. Do not stop after creating a plan.
