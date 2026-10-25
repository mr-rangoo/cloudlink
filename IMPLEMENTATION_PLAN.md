# Cloudlink — Implementation Plan and Progress

Coding agent: update this file continuously. Do not mark items complete without evidence. Record commands and actual outcomes.

## Current status
- [x] Repository inspected. Kit contained specifications only (no application code, no Git repo). Node 24.14.1, npm 11.11, Git 2.53. No Docker/WSL. PostgreSQL 18.3 installed as a Windows service (port 8081, credentials unknown, **not touched**). Another Node app occupies port 3000 (**not touched**); Cloudlink uses 3100 (dev/start) and 3101 (e2e).
- [x] Existing work preserved. All kit documents kept; `.env.example` extended (not replaced in meaning); `.gitignore` extended.
- [x] Architecture confirmed — see `docs/ARCHITECTURE.md`.
- [x] Initial implementation plan reviewed.

## Integration status (truthful)
| Integration | Status | Notes |
| --- | --- | --- |
| M-Pesa Daraja | not_configured | Phase 8. No credentials configured. |
| MikroTik RouterOS | not_configured | Phase 7. No device/private network available. |
| RADIUS | not_configured | Phase 7. |
| Email/SMS | not_configured | Phase 4. |
| Object storage | local disk (dev) | S3 adapter Phase 3/9. |
| Redis/BullMQ | verified locally | Portable Redis 8.10.2 (dev only) on 127.0.0.1:6379; BullMQ dispatch test passes. |

## Phase 1 — Foundation ✅
- [x] App shell and Cloudlink design tokens — `src/app/globals.css` (light/dark tokens), `src/components/shell/app-shell.tsx` (collapsible sidebar, mobile drawer, org/branch selector, breadcrumbs, Ctrl+K command menu, theme selector, user menu, skip link, reduced-motion support). Unbuilt modules route to an explicit "not yet available (phase N)" page. Screenshots reviewed at 1440px and 390px.
- [x] Environment validation and `.env.example` — `src/server/env.ts`; production guard rejects mock adapters, demo seed, http APP_URL, placeholder secrets. Unit-tested.
- [x] PostgreSQL/Prisma schema and first migration — `prisma/schema.prisma`, `prisma/migrations/20261025090833_foundation`. Identity, RBAC, sessions, rate limits, audit, idempotency, background operations, worker heartbeat, integration configuration.
- [x] Redis/BullMQ setup — `src/server/jobs/*`, `src/worker/index.ts`. PostgreSQL is the durable store; BullMQ dispatches; DB sweeper covers Redis outages and crashed workers. Graceful shutdown + heartbeat.
- [x] Authentication and session management — DB-backed sessions (hashed tokens, HTTP-only SameSite cookies), scrypt passwords, per-IP/per-email throttling, lockout, generic errors, audit of login/logout/failures.
- [x] Organization/branch scoping — memberships with branch restriction; `tenantWhere`, `assertBranchAccess`; org switching re-verifies membership.
- [x] Authorization foundation — 47-permission catalogue, 8 default role templates copied per organization; `requirePermission` in every protected handler/page.
- [x] Structured logging and safe error handling — Pino with redaction; stable error envelope with correlation IDs; no stack traces to clients.
- [x] Initial unit/integration test setup — Vitest projects (unit / integration on isolated `cloudlink_test`), Playwright on isolated `cloudlink_e2e`.
- [x] Lint, typecheck, tests and build pass (evidence below).
- [x] OpenAPI foundation — `GET /api/v1/openapi.json` generated from Zod schemas.

## Phase 2 — CRM, catalogue and subscribers ✅
- [x] Leads and activity timeline — stages, sources, owner assignment, call/note/meeting/survey log, auto-advance NEW→CONTACTED, LOST requires reason; atomic conversion (row lock) to subscriber + optional subscription, history preserved and cross-linked. UI: /leads, /leads/[id].
- [x] Packages and pricing — decimal price + tax rate + interval (hour…year × N), speeds/quota/devices, archive guard, unique name per org, DB CHECK constraints. UI: /packages.
- [x] Subscribers and contacts — per-org sequential account numbers (A000001), Kenyan phone normalisation, duplicate phone/email detection with audited override, branch scoping, addresses, notes, timeline. UI: /subscribers, /subscribers/new, /subscribers/[id].
- [x] Subscription lifecycle — commercial snapshot, state machine, timezone-aware periods (month-end/leap-year safe), idempotent renewals (unique event key), suspend/reactivate/cancel, hourly expiry job via worker scheduler. UI: actions on subscriber page, /subscriptions list.
- [x] CSV import preview and validation — row-level errors, duplicates in file and DB, all-or-nothing commit in one transaction, double-commit protection. UI: /subscribers/import.
- [x] Database-backed dashboard — KPIs with written definitions (docs/BILLING.md), permission-aware, unavailable metrics labelled.
- [x] Request idempotency (`Idempotency-Key`) for all mutating staff endpoints; validation failures release the key.

## Phase 3 — Billing and finance ✅
- [x] Invoice engine and immutable line snapshots — decimal per-line rounding, discounts, tax; DRAFT→OPEN issue with gapless numbers; DB triggers freeze issued lines/amounts and forbid deletion; void with reversing entry. UI: /invoices, /invoices/new, /invoices/[id].
- [x] Recurring billing job and deduplication — hourly `billing.run_recurring`; unique generation key per subscription period + row lock (tested with concurrent runs); activation invoices; renew-on-paid with `invoice:<id>` key.
- [x] Partial/full payment allocations — limits (unallocated, invoice balance, same subscriber/currency), oldest-first auto-allocation, lock ordering, concurrency test.
- [x] Manual cash and bank payments — confirmed on entry, gapless receipt numbers, unique references, mandatory Idempotency-Key. UI: /payments, /payments/new, /payments/[id].
- [x] Ledger/reconciliation — double-entry with deferred balance trigger and append-only rows; trial balance; balance checks recomputing every cache; unidentified receipts + matching. UI: /reconciliation.
- [x] Credit notes, refunds and reversals — credit notes split invoice/customer credit; refunds ≤ unallocated; payment reversal undoes allocations; allocation reversal; expenses (+reversal) and withdrawals/bank deposits. UI: /expenses, /collections.
- [x] PDF invoices and receipts — PDFKit, rendered on demand from persisted records, permission-checked.
- [x] Dashboard billing KPIs — receivables, overdue, collected this month, payment exceptions (definitions in docs/BILLING.md).

## Phase 4 — Customer portal and support
- [ ] Customer authentication and ownership checks.
- [ ] Invoice/payment/receipt views.
- [ ] Support tickets.
- [ ] Email/SMS adapters.
- [ ] Notification preferences.

## Phase 5 — Reports and administration
- [ ] Reports and exports.
- [ ] Staff roles/permissions.
- [ ] Branches and organization settings.
- [ ] Audit log search.
- [ ] Import/export job status.

## Phase 6 — Hotspot and vouchers
- [ ] Voucher batches.
- [ ] Atomic redemption.
- [ ] Agent allocation and commission.
- [ ] Captive portal.
- [ ] Mock session activation tests.

## Phase 7 — MikroTik/RADIUS
- [ ] Router inventory.
- [ ] RouterOS adapter.
- [ ] PPPoE/Hotspot session operations.
- [ ] RADIUS integration adapter.
- [ ] Durable network-operation queue.
- [ ] Retry and alert behavior.
- [ ] Real-device test evidence, if hardware/network is available.

## Phase 8 — Payments
- [ ] Daraja sandbox configuration.
- [ ] STK Push.
- [ ] Durable webhook deduplication.
- [ ] Callback validation and payment reconciliation.
- [ ] Additional gateway adapter interface.
- [ ] Production verification, only with approved credentials.

## Phase 9 — Release readiness
- [ ] Full automated test suite passes.
- [ ] Typecheck/lint/build pass.
- [ ] Security review.
- [ ] Tenant isolation verified.
- [ ] Backup/restore tested.
- [ ] Cloud deployment documented and executed if authorized.
- [ ] Health checks and smoke tests pass.
- [ ] Final handover completed.

## Work log

### 2026-10-25 — Phase 1 (Foundation)
**Environment prepared**
- `git init -b main` (repository did not exist).
- Project-local PostgreSQL 18 cluster: `initdb -D .local/pgdata` (scram-sha-256), started on `127.0.0.1:5433`; databases `cloudlink`, `cloudlink_test`, `cloudlink_e2e`. Password stored in git-ignored `.local/`.
- Portable Redis 8.10.2 (redis-windows msys2 build; SHA-256 `7c8cebd5…0ee85` matched the release digest) in `.local/redis`, bound to 127.0.0.1:6379.
- npm install hit repeated `ECONNRESET`; succeeded on attempt 3 with `--maxsockets=4` and project `.npmrc` retry settings. `found 0 vulnerabilities`.
- `npx playwright install chromium`.

**Defect found and fixed**: the local server default timezone is Africa/Nairobi and the Prisma pg adapter sends offset-less timestamps, so Prisma-written instants were stored 3 h off relative to SQL `now()` (caught by the job-retry test). Fixed by pinning connections to UTC (`src/server/db/client.ts`); regression test `tests/integration/database.test.ts`.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npx prisma migrate dev --name foundation` | migration created and applied |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 5 files, 26 tests passed |
| `npm run test:integration` | 6 files, 28 tests passed (includes real BullMQ/Redis test) |
| `npm run build` | exit 0 (Next.js 16.4.3, Turbopack) |
| `npm run test:e2e` | 5 passed (login redirect, invalid login, login/logout, permission-aware nav + server-side 403, command menu) |
| `SEED_PASSWORD=… npm run db:seed` | 2 demo orgs, 7 staff accounts created |
| `npm run worker` (DB-polling mode) | processed a `system.ping` operation → SUCCEEDED; heartbeat written |
| HTTP smoke via curl against `next start` | live/ready OK, anonymous → 307 /login, bad login → generic 401 envelope, login → cookie, dashboard 200, security headers present |

**Still mocked / blocked**: payments, network, messaging adapters are not implemented yet (configured as `mock` in dev). Business KPIs on the dashboard await Phase 2+ modules.

**Next task at the time**: Phase 2 (completed below).

### 2026-10-25 — Phase 2 (CRM, catalogue, subscribers, subscriptions)
**Schema**: migration `20261025092149_crm_catalogue_subscribers` (OrganizationCounter, Package, Subscriber + contacts/addresses/activity, Subscription + events, Lead + activity, ImportJob) and `20261025100000_domain_check_constraints` (CHECK constraints on prices, tax rates, counts, period order, currency format).

**Defects found and fixed during the phase**
- Optional-field schemas converted an absent field to `null`, so a PATCH sending one field would have cleared the others. Fixed (absent stays absent) and covered by tests asserting untouched fields.
- A validation failure (e.g. suspension without a reason) was stored under the idempotency key, so the corrected resubmission was rejected as a key conflict. Fixed server-side (validation errors release the key) and client-side (key rotates after any server answer; reused only after network failures). Covered by an integration test and the e2e suspend flow.
- Prisma 7 `migrate dev` no longer runs `generate`; `npm run db:migrate` now runs both.
- The CHECK-constraint migration failed on the *test* database because tests had backdated period ends without moving period starts (data real flows cannot produce). Test DB data cleared, migration marked rolled back and re-applied, tests corrected. Lesson: future data-constraining migrations will wrap statements in an explicit transaction.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 6 files, 53 tests passed |
| `npm run test:integration` | 9 files, 62 tests passed |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 10 passed (adds: package → subscriber → suspend/reactivate; duplicate warning + override; lead → subscriber with history; CSV import errors then commit; cashier denied create/import) |

**Still mocked / blocked**: network provisioning is shown as "Not provisioned" (phase 7); invoices/payments (phase 3).

**Next task at the time**: Phase 3 (completed below).

### 2026-10-25 — Phase 3 (Billing and finance)
**Schema**: migration `20261025100500_billing_finance` (BillingSettings, Invoice/InvoiceLine, CreditNote(+lines), Payment, PaymentAllocation, Refund, LedgerAccount/Transaction/Entry, ExpenseCategory, Expense, Withdrawal, ReconciliationRecord; Subscription.invoicedThrough). Wrapped in BEGIN/COMMIT, with triggers: ledger balance (deferred constraint trigger), append-only ledger/refunds/credit notes, issued-invoice immutability; CHECK constraints for amounts and cache consistency.

**Defects found and fixed during the phase**
- With zero payment terms the due date was the issue instant, so invoices showed as overdue seconds after issue. Due dates are now the end of the local day (organization timezone). Unit + integration assertions added.
- Prisma generated the billing migration with a timestamp earlier than the hand-written constraint migration; renamed so migrations apply in order.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 7 files, 61 tests passed (adds invoice math: rounding, discounts, allocation order, credit split) |
| `npm run test:integration` | 10 files, 82 tests passed (adds 20 billing tests: ledger triggers, gapless numbers, recurring billing ×3 concurrent, partial/full payments + renewal once, late payment restart, overpayment credit, allocation limits + concurrency, HTTP idempotency, credit notes, refunds, reversals, unmatched matching, tamper detection, tenant isolation, PDFs) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 13 passed (adds: activation invoice → partial → full payment with receipt/invoice PDFs; accountant matches unidentified bank receipt and balance checks pass; cashier refund blocked in UI and API 403) |

**Still mocked / blocked**: M-Pesa (phase 8) — manual M-Pesa entries only; payment gateway callbacks not yet implemented. Object storage not needed yet (PDFs rendered on demand).

**Exact next task**: Phase 4 — customer portal and support: customer accounts (User kind CUSTOMER linked to Subscriber) with separate session handling and ownership checks; portal pages for invoices/payments/receipts/profile; support tickets (staff + customer) with comments and timeline; email/SMS adapters (mock + SMTP) with notification records and preferences; notifications on invoice issue/payment receipt.

## Resume instruction
When resuming, inspect Git status, read this checklist and recent work log, verify the current app state, and continue from the first incomplete item. Do not repeat completed work unless a regression requires it.

Local services: `npm run db:local:start` (PostgreSQL :5433) and start Redis from `.local/redis/Redis-8.10.2-Windows-x64-msys2/redis-server.exe --bind 127.0.0.1 --port 6379` if needed.
