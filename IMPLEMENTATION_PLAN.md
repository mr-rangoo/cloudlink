# Cloudlink — Implementation Plan and Progress

Coding agent: update this file continuously. Do not mark items complete without evidence. Record commands and actual outcomes.

## Current status
- [x] Repository inspected. Kit contained specifications only (no application code, no Git repo). Node 24.14.1, npm 11.11, Git 2.53. No Docker/WSL. PostgreSQL 18.3 installed as a Windows service (port 8081, credentials unknown, **not touched**). Another Node app occupies port 3000 (**not touched**); Cloudlink uses 3100 (dev/start) and 3101 (e2e).
- [x] Existing work preserved. All kit documents kept; `.env.example` extended (not replaced in meaning); `.gitignore` extended.
- [x] Architecture confirmed — see `docs/ARCHITECTURE.md`.
- [x] Initial implementation plan reviewed.
- [x] Phases 1–9 complete (2026-10-26). Remaining work needs external credentials, hardware or authorization — see the phase 9 work log and `docs/HANDOVER.md`.
- [x] Phase 10 (user request: themes, payment methods, live sessions, AI chat) complete (2026-10-26) — see the phase 10 work log.
- [ ] Phases 11–22 (user request 2026-10-30: "I need all this in my billing system", 29 screenshots of the user's current Centipid account) — in progress, see "Phases 11–22" below. Features are rebuilt as Cloudlink's own design; no Centipid code, copy, names or assets are reused.

## Integration status (truthful)
| Integration | Status | Notes |
| --- | --- | --- |
| M-Pesa Daraja | implemented, mock in dev | Adapter tested against an in-process fake Daraja server only. **Sandbox and production not verified**: no credentials supplied. |
| MikroTik RouterOS | implemented, mock in dev | RouterOS API adapter tested against an in-process fake RouterOS API server only. **Not verified on hardware** (no device or private network available). |
| RADIUS | implemented, not configured | FreeRADIUS SQL adapter tested against PostgreSQL tables (rlm_sql dialect). **Not verified with a real FreeRADIUS server.** |
| Email | mock (dev) | SMTP adapter implemented via nodemailer, not verified against a real server. |
| SMS | mock (dev) | Africa's Talking adapter implemented from public docs, not verified. |
| Object storage | local disk (dev) | Ticket attachments; S3 adapter not implemented (reports unavailable). |
| Redis/BullMQ | verified locally | Portable Redis 8.10.2 (dev only) on 127.0.0.1:6379; BullMQ dispatch test passes. |
| Claude API (portal assistant) | implemented, test mode in dev | Official `@anthropic-ai/sdk` 1.3.0, model `claude-opus-5-5`. Tested in test mode and against an in-process fake Messages API only. **Not verified with a real API key** (none supplied). |

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

## Phase 4 — Customer portal and support ✅
- [x] Customer authentication and ownership checks — separate CustomerAccount/CustomerSession (cookie `cloudlink_portal`), phone-or-account-number login, throttling + lockout, single-use hashed invite tokens (minted at send time), enable/disable revokes sessions; every portal query scoped by the session's subscriber (other ids → 404); customer sessions rejected by staff APIs.
- [x] Invoice/payment/receipt views — /portal/home (balance, service, how to pay), /portal/invoices(+PDF), /portal/payments(+receipt PDF), /portal/profile.
- [x] Support tickets — staff (/support, /support/[id]) and portal (/portal/tickets): numbering, statuses with events, internal notes, auto IN_PROGRESS on first reply, reopen on customer reply, resolution required, content-validated attachments via storage adapter.
- [x] Email/SMS adapters — mock (simulated), SMTP (nodemailer), Africa's Talking SMS (unverified), NotConfigured → SKIPPED; outbox notifications for invoice issued, payment received, ticket reply/resolved, portal invite; templates editable at /notifications.
- [x] Notification preferences — per subscriber/channel/category (portal profile + staff API); account messages always sent.
- [x] Staff notification centre (bell) with live permission-filtered alerts; worker health endpoint (`WORKER_HEALTH_PORT`).

## Phase 5 — Reports and administration ✅
- [x] Reports and exports — revenue/credit notes/tax/collections/expenses from the ledger, receivables aging (= AR), subscriber growth + lifecycle, collections by method; Recharts with validated CVD-safe palette, tooltips and data tables; CSV exports via worker with formula-injection protection, 24 h authenticated downloads, audited. UI: /reports.
- [x] Staff roles/permissions — invite with single-use setup link, edit roles/branch scope/status (revokes sessions), reset links, owner/self-lockout guards; role editor (owner locked, custom roles). UI: /staff, /invite/[token].
- [x] Branches and organization settings — branch CRUD with archive guard; org name/timezone + billing settings (prefixes, lead days, terms, tax details). UI: /branches, /settings.
- [x] Audit log search — filters + export. UI: /audit-logs.
- [x] Import/export job status — imports on /subscribers/import, exports on /reports?tab=exports.
- [x] Inventory — equipment with status machine, movement history, subscriber timeline entries. UI: /inventory.
- [x] Integrations status page — honest per-provider status, no secrets. UI: /integrations.

## Phase 6 — Hotspot and vouchers ✅
- [x] Voucher batches — package snapshot (face value incl. tax), unambiguous random codes, keyed HMAC + AES-GCM storage (plaintext shown once), audited PDF-card/CSV export of unused codes, void, redeem-by date. UI: /vouchers, /vouchers/batches/[id].
- [x] Atomic redemption — row lock + unique redemption (8 concurrent attempts → 1 success), expiry handling, generic errors, ledger posting (receivable/revenue/tax).
- [x] Agent allocation and commission — agents with commission %, commission accrued on redemption, remittances capped at amount owed, ledger 1150 reconciled with records.
- [x] Captive portal — public /hotspot/[org] with MikroTik parameters, rate limits, same-origin, status polling with code proof; router login only after ACTIVE.
- [x] Mock session activation tests — durable `hotspot.activate` job; mock → SIMULATED (labelled "test mode"), disabled/unimplemented → FAILED with reason.

## Phase 7 — MikroTik/RADIUS ✅ (hardware verification pending)
- [x] Router inventory — `src/server/services/routers.ts`; private/VPN IP literals only (RFC 1918, CGNAT, ULA; public IPs and hostnames refused; `MIKROTIK_ALLOWED_NETWORKS` enforced, mandatory in production); AES-256-GCM credentials bound to `router:<id>`, write-only; archive guard. UI: /routers, /routers/[id] (edit, replace credentials, check now, archive, disconnect session).
- [x] RouterOS adapter — `src/server/integrations/routeros/{protocol,client}.ts` (binary API, 1–5 byte length prefixes, split-frame reader, `!re/!done/!trap/!fatal`, post-6.43 login, TCP or TLS, per-reply timeouts, control-character injection guard) and `src/server/integrations/network.ts` (read-back verification on every write; error classification).
- [x] PPPoE/Hotspot session operations — allowlisted `pppoe.enable|disable|remove`, `session.disconnect`, `hotspot.user.upsert`; provisioning, move, re-sync, removal and audited credential reveal on the subscriber page; voucher activation rewired through network operations; session sync from `/ppp/active`, `/ip/hotspot/active` or `radacct`. UI: /sessions (sessions, operations, alerts), /sessions/operations/[id].
- [x] RADIUS integration adapter — `src/server/integrations/radius.ts` (radcheck/radreply/radusergroup writes in one transaction with read-back, radacct sessions); `deploy/radius/schema.sql`; NAS/firewall/topology documented in `docs/NETWORK.md`.
- [x] Durable network-operation queue — `NetworkOperation` written in the same transaction as the billing change; unique idempotency key; superseding of queued older state; ordering per subscription; staleness guard; append-only `NetworkOperationAttempt`.
- [x] Retry and alert behavior — retryable vs permanent classification, 5 attempts with backoff, FAILED → critical alert, stuck-operation monitor, router offline alerts, staff retry/cancel (audited), alerts in the notification centre and dashboard.
- [x] One-time router setup command (added 2026-10-26 at the user's request) — `/tool fetch … /import` line generated per router: 256-bit single-use token (hash stored), 30-minute expiry, credentials rotated on download, original idempotent script (limited API user, API restricted to `ROUTER_MANAGEMENT_SOURCES`, firewall guard, optional RADIUS and walled garden, self-deleting file). Script content unit-tested; not run on hardware.
- [ ] Real-device test evidence — **blocked**: no MikroTik device or private network available. Procedure in `docs/NETWORK.md` → "Testing against a real router".

## Phase 8 — Payments ✅ (sandbox/production verification pending credentials)
- [x] Daraja sandbox configuration — per-organization settings under Integrations (environment, paybill/till, shortcode, AES-256-GCM encrypted credentials, write-only), single-tenant `MPESA_*` fallback, credential test (OAuth only), C2B URL registration; status becomes "Sandbox tested" only after a confirmed sandbox payment. **Sandbox run blocked: no credentials supplied.**
- [x] STK Push — `src/server/integrations/payments/daraja.ts` (OAuth with token refresh, STK Push, STK Query, C2B register; documented password example reproduced); staff "Request M-Pesa" and portal "Pay with M-Pesa" with live server-side status; idempotent, rate-limited, whole-shilling and invoice-balance rules.
- [x] Durable webhook deduplication — `WebhookEvent` unique per provider/kind/key (STK keyed by request + CheckoutRequestID; C2B by TransID); identical repeats counted, conflicting repeats flagged and judged separately; minimised payloads.
- [x] Callback validation and payment reconciliation — per-request secret callback URLs (hash stored), identifier and amount checks, mandatory provider status-query verification of every outcome (production), optional source allowlist, receipt unique per organization across STK/C2B/manual (partial unique index), status-query job for missing callbacks, UNKNOWN requests surfaced for review, C2B matching by account/invoice/phone with unmatched receipts sent to Reconciliation, no expiry while a payment is in progress.
- [x] Additional gateway adapter interface — `PaymentGateway` (request, query, test credentials, register C2B) with Daraja and mock implementations; documented in `docs/PAYMENTS.md`.
- [ ] Production verification — **blocked**: requires approved production credentials and a real payment.

## Phase 9 — Release readiness ✅ (deployment not authorized; external verifications pending)
- [x] Full automated test suite passes — unit 104, integration 152, e2e 22 (final run below).
- [x] Typecheck/lint/build pass — plus the bundled worker (`npm run build:worker`).
- [x] Security review — `docs/SECURITY_REVIEW.md`: 6 findings fixed (open redirect, CSP/HSTS, __Host- cookie clearing, hotspot rate limits, foreign router filters, monitoring alerts); `npm audit` 0 vulnerabilities. Not an external penetration test.
- [x] Tenant isolation verified — static route-guard test (every route wrapped or allowlisted; staff mutations carry permissions) and a 25-probe cross-organization sweep (all 404, nothing changed).
- [x] Backup/restore tested — `scripts/db-backup.mjs` / `scripts/db-restore.mjs`; restored into a new database: 70 tables, 829 rows, 0 mismatches, identical triggers/checks/indexes, migrate status up to date; overwrite refused. Repeat on the production provider.
- [ ] Cloud deployment documented and executed if authorized — **documented** (`docs/DEPLOYMENT_GUIDE.md`, `Dockerfile`, `deploy/compose.production.yaml`, `deploy/Caddyfile`); **not executed**: no authorization or cloud account, and Docker unavailable on this machine (image not built).
- [x] Health checks and smoke tests pass — production-mode run (`APP_ENV=production`, mocks off) on a fresh migrated database: `scripts/smoke.mjs` 11/11 (readiness, CSP nonce on all scripts, HSTS, auth refusal envelope, generic login errors, webhook/setup token rejection, worker readiness, sign-in → session → sign-out invalidation).
- [x] Final handover completed — `docs/HANDOVER.md`, README pointer, `docs/OPERATIONS.md`.

## Phase 10 — Personalisation, live sessions and AI assistant ✅ (real Claude key not verified)
- [x] Branding: 7 WCAG-checked theme presets, contrast-checked brand colour, light/dark/system default, logo upload, portal welcome/support hours — applied to staff app, portal, sign-in and hotspot pages.
- [x] Customer payment methods (paybill, till, bank, cash, other), personalised per account in the portal, invoice page and invoice PDFs.
- [x] Live sessions: live mode on the sessions page (30 s de-duplicated sync requests, 10 s refresh, online counts, stale warning); customer "My connection" card and API; deterministic simulated sessions in test mode only; daily pruning of routine jobs.
- [x] AI assistant: Claude chat in the portal with six customer-scoped tools, one ticket per chat, append-only replay, refusal/limit handling, rate limits, disclosure, staff transcripts (branch-scoped), settings tab, 180-day retention, production env guards.
- [ ] Verify the assistant with a real Anthropic API key on staging — **blocked**: no key supplied.

## Phases 11–22 — feature parity with the user's current ISP platform (user request 2026-10-30)
The user shared 29 screenshots (overview, live sessions, subscribers, plans + plan form, routers list/detail/actions/reports, link-router wizard, TR-069, equipment, payments, expenses, captive-portal templates, payment gateways, SMS providers, message templates, loyalty points, AI settings). Gap analysis against phases 1–10:

| Area | Already in Cloudlink | Missing (to build) | Phase |
| --- | --- | --- | --- |
| Plans | packages with price, period, kbps, quota, devices, router profile | plan kinds (time/data bundle/trial/device), live/hidden/off, popular/on-offer, MikroTik rate-limit strings, burst, fair-use policy, time-of-day schedule, router (NAS) restriction, revenue/subscriber stats, full-page form, profile push to routers | 11 |
| Hotspot sales | vouchers, captive portal voucher login | M-Pesa self-purchase on the captive portal with verified callback → subscription → router user → auto-login; reconnect with M-Pesa code; hotspot subscribers expiring to the minute; activation timing; router login page sync | 12 |
| Captive portal | one design, themed | several original templates with previews, hotspot settings (support number, instructions, tabs) | 13 |
| Routers | inventory, health check, setup command, sessions, operations | telemetry samples + charts (CPU/memory/disk/traffic/latency/reachability), health score, diagnose, sync time, walled garden, hotspot files, reboot, identity, maintenance mode, backups, logs, reports tab, link wizard | 14 |
| Overview / live sessions / subscribers / navigation | KPI dashboard, sessions table, subscriber list | greeting + live ticker, revenue today vs yesterday, what's next, renewals due, busiest routers, subscriber health; traffic stats + expiry in sessions; subscriber stats, service tabs, filters (VIP, at risk, offline, router, created), last online, NAS, compensation; grouped navigation with counts; record search (Ctrl+K) | 15 |
| Payments / expenses | ledger, payments list, expenses | period stats, type/reconciled/activation columns, CSV export | 16 |
| Messaging | SMS (Africa's Talking, env only), email, templates | per-organization SMS provider catalogue + test send + credit balance, service templates (welcome, receipts, voucher delivery, credit saved, expiry), bulk SMS/campaigns, operator alerts, per-org SMTP, WhatsApp | 17 |
| Payment gateways | M-Pesa Daraja (STK/C2B), manual | gateway catalogue with one active gateway, additional adapters | 18 |
| Loyalty | — | points programme (earn per spend, redeem for credit, ledger-backed) | 19 |
| Equipment / TR-069 | inventory with movements | sale price + payments against equipment, returned/damaged/sold; TR-069 device registry with ACS adapter | 20 |
| AI / developer / security | portal assistant (Claude, env key) | staff "Ask AI" with organization tools, per-org API key, API tokens + outbound webhooks, staff 2FA | 21 |
| Insights | reports | fiber map, ticket analytics, analytics page, promo banners / hotspot ads | 22 |

Order: 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22, one commit per phase, tests/lint/typecheck/build after each.

### Phase 11 — Plans engine ✅
- [x] Plan kinds (time, data bundle, trial, TV/device) on top of the access type; Live / Hidden / Off; Popular / On offer labels; display order — `prisma/migrations/20261030090000_plans_engine` (CHECK constraints for burst, FUP, schedule, labels; same-organization trigger on `PackageRouter`).
- [x] MINUTE billing unit for short hotspot plans (`src/server/domain/billing-period.ts`).
- [x] MikroTik rate strings, burst, durations, schedules — `src/lib/plans.ts` (shared by form and server; unit-tested).
- [x] Validation of the merged plan on create and PATCH (`planProblems`); PATCH no longer resets absent fields to defaults (latent bug in the old schema, regression-tested).
- [x] Router profile push: `profile.sync` network operation (PPP profile or hotspot user profile with rate-limit incl. burst and shared-users), read-back verified, superseding, idempotent per plan version; triggered on save, per plan (`POST /packages/:id/sync`) and per router (`POST /routers/:id/sync-plans`).
- [x] Router restriction enforced when provisioning PPPoE and issuing vouchers; schedule enforced at voucher redemption.
- [x] Plans page (stats, type tabs, speed/duration/devices/burst/schedule chips, subscribers, revenue 30d, status, row menu: edit, duplicate, live/hidden/off, push, archive/restore) and full-page create/edit form with push history.
- [ ] Fair use policy enforcement — stored and validated; applying it needs per-subscription usage collection (phase 14). The form says so.
- [ ] Disconnecting active sessions when a scheduled plan's window closes — with hotspot subscriptions (phase 12).

| Command (2026-10-30) | Result |
| --- | --- |
| `npx prisma migrate dev` (dev) / `migrate deploy` (test, e2e) | `20261030090000_plans_engine` applied |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm run test` | 16 files, 135 tests passed (adds `tests/unit/plans.test.ts`: rates, burst, schedules incl. midnight and Sunday wrap, durations, minute periods) |
| `npm run test:integration` | 22 files, 175 tests passed (adds `tests/integration/plans.test.ts`: rules on create and merged PATCH, PATCH regression, same-organization restriction incl. DB trigger, hotspot and PPP profile push verified on the fake RouterOS server, superseding and per-version idempotency, restriction at provisioning, schedule at voucher redemption, catalogue counts/revenue/permissions, duplicate, push permission) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 23 passed (six specs now create plans through the new form via `createPlan`) |

Fixes made during the phase: required-field asterisks are hidden from assistive technology (the input's `required` already announces it); tests that relied on one-letter plan names, raw `P2002` errors or binary (1024) rate units were updated to the new behaviour. Visual check: plans list and form at 1440 px and 390 px against a production build.

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

**Next task at the time**: Phase 4 (completed below).

### 2026-10-25 — Phase 4 (Customer portal, support, notifications)
**Schema**: migration `20261025102814_portal_support_notifications` (CustomerAccount, CustomerSession, SupportTicket, TicketComment, TicketEvent, TicketAttachment, NotificationTemplate, Notification, NotificationPreference) wrapped in a transaction with attachment-size and single-author checks.

**Defects found and fixed during the phase**
- "Resolved requires a resolution" was only enforced by the API schema; direct service calls could bypass it. Now enforced in the service too.
- Storage key validation rejected file extensions (no dot allowed). Fixed; covered by the attachment test.
- The e2e suite had no worker, so it could not prove notification delivery. Added a worker health endpoint and Playwright now starts the real worker.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 8 files, 64 tests passed (adds upload sniffing, filename sanitising, template rendering) |
| `npm run test:integration` | 11 files, 94 tests passed (adds 12 portal/support/notification tests incl. cross-customer 404s, staff-API rejection, lockout/disable, invite token never stored, opt-outs, unconfigured → SKIPPED, attachment ownership) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 15 passed (adds: customer activates + signs in + views own invoice/PDF, other customer's invoice 404 (page + API), staff API 401 with customer session, portal ticket → staff reply + internal note hidden → notification delivered by the real worker as simulated; generic portal login failure) |

**Still mocked / blocked**: messaging providers (mock only; SMTP/Africa's Talking unverified); S3 storage; portal online payment (phase 8).

**Next task at the time**: Phase 5 (completed below).

### 2026-10-25 — Phase 5 (Reports and administration)
**Schema**: migration `20261025105314_admin_reports_inventory` (StaffInvite, ExportJob, InventoryItem, InventoryMovement) with CHECKs (assigned ⇔ subscriber, non-negative cost).

**Defects found and fixed during the phase**
- Branch service trusted pre-parsed input; a direct call stored a lower-case code. The service now normalises its own input.
- An e2e settings test changed the invoice prefix, which would have broken later specs that matched `INV-`; specs now accept any valid prefix.
- Export generation originally depended on the requester's browser session; it now re-resolves the requester's live membership and permissions.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 8 files, 64 tests passed |
| `npm run test:integration` | 12 files, 109 tests passed (adds 15: reports reconcile with trial balance and AR, aging buckets, timezone month ranges, export generation/formula neutralisation/audit/expiry/tenant isolation/permission/revoked requester, staff invite + single-use link, owner and self-lockout guards, session revocation on role change, reset links, role editing effect, branch archive guard, settings → invoice prefix and due date, audit search isolation, inventory transitions + DB check, integration status honesty) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 18 passed (adds: invite → set password → restricted nav and 403 on settings → link reuse rejected; reports chart + aging + CSV export generated by the worker and downloaded; settings save audited) |
| `node scripts/validate_palette.js` (data-viz skill) | categorical slots 1–6 PASS on Cloudlink light (#ffffff) and dark (#111b2c) surfaces; light contrast WARN on 3 slots → every chart ships with a data table |

**Still mocked / blocked**: unchanged (payments gateway, router/RADIUS, messaging providers, S3).

**Next task at the time**: Phase 6 (completed below).

### 2026-10-25 — Phase 6 (Hotspot and vouchers)
**Schema**: migration `20261025143404_hotspot_vouchers` (Agent, VoucherBatch, Voucher, VoucherRedemption, AgentCommission, AgentRemittance) with CHECKs and append-only triggers; ledger accounts 1150 Voucher receivable and 5100 Agent commissions.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm run test` | 9 files, 67 tests passed (adds voucher code alphabet, normalisation, tenant-scoped hashing) |
| `npm run test:integration` | 13 files, 117 tests passed (adds 8: no plaintext codes stored, export permission + audit + unused only, ledger postings + duration, 8-way concurrent redemption → 1, unknown/void/expired/other-tenant rejection, portal rate limit + code-proof status + SIMULATED activation, FAILED when network disabled, agent commission/remittance cap/ledger reconciliation) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 19 passed (adds: hotspot package → batch → codes once + PDF cards → guest redeems on captive portal → "test mode" after real worker → reuse rejected → staff sees Simulated) |

**Still mocked / blocked**: hotspot activation is SIMULATED (RouterOS adapter is phase 7; needs a device on a private network). Online voucher purchase needs M-Pesa (phase 8).

**Exact next task**: Phase 7 — MikroTik/RADIUS: Router model (management address on a private network, allowlist check against MIKROTIK_ALLOWED_NETWORKS, encrypted credentials), NetworkOperation + NetworkOperationAttempt (durable, idempotent, allowlisted operation types, status history, retry classification), RouterOS API adapter (binary API protocol over TCP/TLS with timeouts; real-device testing only when hardware is available), mock adapter with failure injection, PPPoE secret provision/enable/disable and hotspot user operations, subscription lifecycle → network operations (activate/suspend/reactivate/expire), RADIUS adapter interface, router health checks + alerts, UI for routers/sessions/operations, and wiring hotspot activation through the new queue.

### 2026-10-25 — Phase 7 (MikroTik RouterOS, PPPoE, Hotspot, RADIUS)
**Schema**: migrations `20261025150000_network_routers_radius` (Router, RouterCredential, NetworkOperation, NetworkOperationAttempt, NetworkSession, RouterAlert; Subscription network fields with a unique PPPoE username per organization; Package.networkProfile; VoucherBatch.routerId) and `20261025150100_network_constraints` (port and attempt CHECKs, append-only attempt trigger). Both wrapped in transactions; applied with `prisma migrate deploy` to the test and e2e databases.

**What was built**
- Network engine `src/server/services/network.ts`; worker jobs `network.execute`, `routers.healthcheck` (15 min), `network.sync_sessions` (5 min), `network.monitor` (15 min), scheduled only for organizations with routers.
- Subscription lifecycle hook: activate/reactivate/renew → enable, suspend/expire/cancel → disable, inside the same transaction as the billing change; payment renewals dispatch immediately.
- 19 endpoints (`/routers…`, `/network/operations…`, `/network/alerts…`, `/network/sessions`, `/subscriptions/:id/network…`); OpenAPI now 158 operations.
- Dashboard "Network" and "Support workload" cards replace the "not yet available" card. Package form gains "Router profile"; voucher batches can name a hotspot router.
- /integrations reports RouterOS as `ok` only when a real (non-mock) health check has seen a router online, and RADIUS as `ok` only when its tables answer a live query.

**Defects found and fixed during the phase**
- The idempotency store would have persisted a revealed PPPoE password in its response copy. Routes can now declare `secretResponse`, which bypasses storage; covered by a test.
- The per-IP login limit counted successful sign-ins, so the larger e2e suite (and any office sharing one NAT address) was locked out after 20 sign-ins in 15 minutes. Successful sign-ins now refund their unit, so only failures accumulate; covered by a new test.
- The operations list overflowed horizontally on phones (non-wrapping detail text, multi-part cells laid out side by side). Fixed and re-checked at 390 px and 1440 px.
- The dashboard still listed support and network metrics as unavailable after those modules shipped. Replaced with real, permission-aware counts.
- The subscriber page still showed the phase-6 placeholder ("provisioning not connected"). Replaced with the real network card.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 10 files, 82 tests passed (adds 15: protocol framing at every length boundary, split-frame reassembly, UTF-8, injection guards, address policy, allowlist validation, production guards, duration/rate helpers, retry classification) |
| `npm run test:integration` | 15 files, 135 tests passed (adds 18: encrypted write-only credentials, address/TLS policy, health checks and offline alerts, provision → suspend → reactivate with read-back, superseding, transient retry with attempt log, timeout retry, permanent failure → alert → staff retry, exhaustion after 5 attempts, cancel/move/deprovision/audited reveal, session sync and closing, stuck alert, hotspot activation on the router, mock flaky retry, authorization/tenant/branch isolation, reveal never stored; RADIUS radcheck/radreply/radusergroup, radacct sessions, unconfigured RADIUS; per-IP login refund) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 21 passed (adds flow 11: a `[flaky]` mock router's failure is visible in the attempt log and retried per policy to SIMULATED; flow 10: cashier cannot see routers or sessions and gets 403 from the router operation and health-check APIs; public router address refused in the UI) |

**Still mocked / blocked**
- No MikroTik hardware or private network: the RouterOS adapter is verified only against the fake API server; `NETWORK_ADAPTER=mock` in development.
- No FreeRADIUS server: RADIUS provisioning is verified against compatible tables only. RADIUS CoA/Disconnect-Message is not implemented (disconnects use the router API).
- Payments gateway (phase 8), messaging providers, S3 storage: unchanged.

**Exact next task**: Phase 8 — Payments: payment provider interface (pending/confirmed/failed/cancelled/reversed/unknown), M-Pesa Daraja adapter (OAuth token, STK Push with idempotent payment attempts, callback endpoint with validation and durable event deduplication, transaction status query for unknown outcomes), mock adapter for development, portal "Pay with M-Pesa" and voucher purchase, allocation and renewal on confirmed callbacks only (never on redirects), reconciliation of unmatched C2B receipts. Use sandbox credentials only when the user supplies them.

### 2026-10-26 — Phase 8 (Payments: M-Pesa Daraja)
**Schema**: migration `20261025190000_payment_gateways` (PaymentAttempt, WebhookEvent, CHECKs, partial unique index "one live payment per M-Pesa receipt per organization"). Verified beforehand that the dev, test and e2e databases had no duplicate receipts.

**Defects found and fixed during the phase**
- Callbacks were first deduplicated by CheckoutRequestID alone: a callback posted on one request's URL with another request's identifiers would have shadowed the genuine callback of the second request. Events are now keyed by request + CheckoutRequestID (test covers it).
- Failure callbacks were initially applied without asking M-Pesa, so a forged "cancelled" arriving first could hide a real payment. Every outcome is now verified with an STK status query, and repeats with a different body are processed on their own (test covers it).
- The portal's payment result disappeared when the page refreshed after confirmation (the form lived inside the "amount due" branch). The form now stays mounted; found by the e2e test.
- The manual-payment path and the gateway path duplicated payment + ledger code; extracted `createConfirmedPaymentTx` so both use one implementation.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test` | 11 files, 92 tests passed (adds 10: EAT timestamps, documented STK password example, MSISDN rules, amount/reference limits, result-code mapping, documented callback and C2B payloads, source allowlist, production guards) |
| `npm run test:integration` | 16 files, 148 tests passed (adds 13: request shape + idempotency + verified confirmation + invoice paid + ledger + duplicate/tampered repeats + sandbox_tested status; unknown/malformed/forged/mismatched/off-allowlist callbacks; cancellations/failures; status queries never record money alone + late confirmation; deferred verification; rejected/unreachable provider + token refresh + bad credentials; encrypted settings + till requests + permissions; rate limit; forged failure cannot hide a payment; C2B matching/unmatched/duplicates/shortcode/manual conflict/validation; renewal re-enables network + no expiry during payment; portal ownership; mock simulation labelled and refused in production) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 22 passed (adds: customer pays an invoice with M-Pesa in the portal, staff simulates the response, customer sees "Paid (simulated)" with an SIM receipt and a zero balance) |

**Still mocked / blocked**
- No Daraja credentials: sandbox and production unverified; development uses `PAYMENT_ADAPTER=mock`.
- Not implemented: B2C refunds/reversals, C2B Transaction Status verification, online hotspot voucher purchase, other gateways.

**Exact next task**: Router onboarding command (user request, 2026-10-26): Cloudlink's own single-use, expiring `/tool fetch … /import` script per router. Then Phase 9 — release readiness.

### 2026-10-26 — Router setup command (user request)
The user shared the command their current provider uses to connect MikroTik routers (a third-party URL with an embedded token). It was **not** fetched or run: it belongs to another product, its token is a credential, and AGENTS.md forbids copying proprietary scripts. The URL was not written to any file (checked with `git grep`). Cloudlink's own equivalent was built instead:
- Migration `20261026090000_router_setup_command` (Router.setupTokenHash unique, setupExpiresAt, onboardedAt, onboardedFromIp).
- `src/server/domain/routeros-setup.ts` (script builder, RouterOS string escaping), `src/server/services/router-setup.ts`, `POST /routers/:id/setup-command` (routers.write; response never stored for idempotent replay), public `GET /routers/setup/:token` (text/plain, no-store, rate-limited), "Setup command" dialog on the router page, `ROUTER_MANAGEMENT_SOURCES` (validated as private addresses).

| Command | Result |
| --- | --- |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm run test` | 12 files, 97 tests passed (adds 5: script content, TLS/RADIUS/walled-garden variants, escaping and name sanitising, command format, env validation) |
| `npm run test:integration` | 17 files, 150 tests passed (adds 2: single use, credential rotation, RADIUS secret and walled garden in the script, health check queued, audit without secrets; expiry, replacement, archived routers, permissions, tenancy, no idempotent storage) |
| `npm run build` | exit 0 |
| `npm run test:e2e` | 22 passed |

**Exact next task**: Phase 9 — release readiness (security review, backup/restore test, deployment artefacts and docs, smoke tests, handover).

### 2026-10-26 — Phase 9 (Release readiness)
**What was done**
- Security review with fixes (see `docs/SECURITY_REVIEW.md`): `safeRedirectPath` for post-login redirects; nonce-based CSP and production HSTS in `src/proxy.ts`; `clearedCookieOptions()` for sign-out; failure-based captive-portal limits and a limited status endpoint; router filters must be in scope (404 otherwise); new alerts for stuck payment callbacks and job backlog.
- Guard tests: `tests/unit/route-guards.test.ts`, `tests/unit/security-headers.test.ts`, `tests/integration/tenant-sweep.test.ts`, extra voucher test.
- Operations: backup/restore scripts (checksums, refuse non-empty targets, row-count comparison), smoke test script, worker bundle (`esbuild` pinned 0.28.2), Dockerfile/compose/Caddy, `.dockerignore`, deployment and operations guides, handover.
- Temporary databases `cloudlink_restore_check` and `cloudlink_smoke` were created for the restore and smoke tests and dropped afterwards; only `cloudlink`, `cloudlink_test`, `cloudlink_e2e` remain on the project-local cluster. The user's PostgreSQL service (port 8081) and port-3000 app were not touched.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 (after excluding the generated `dist/` bundle) |
| `npm run typecheck` | exit 0 |
| `npm run test` | 14 files, 104 tests passed |
| `npm run test:integration` | 18 files, 152 tests passed |
| `npm run build` / `npm run build:worker` | exit 0 / exit 0 |
| `npm run test:e2e` | 22 passed (with the CSP active) |
| `npm audit` | 0 vulnerabilities |
| `node scripts/db-backup.mjs` + `db-restore.mjs --create --compare-with` | 0 mismatches over 70 tables / 829 rows |
| `node scripts/smoke.mjs` (production mode) | 11/11 passed |

**Still mocked / blocked (needs the user)**
- M-Pesa sandbox/production credentials; a MikroTik router over VPN; SMTP/SMS accounts; hosting authorization and domain; legal/privacy review and an external penetration test. See `docs/HANDOVER.md` → "What you need to provide next".

**Exact next task**: when credentials or hardware arrive — (1) M-Pesa sandbox run per `docs/PAYMENTS.md` → Configuration; (2) real-router test per `docs/NETWORK.md` → "Testing against a real router"; (3) deployment per `docs/DEPLOYMENT_GUIDE.md`. Record each result here.

### 2026-10-26 — Phase 10 (user request: "change theme, add payment method, AI integrated for chats, show live sessions")
The user pointed at another vendor's settings page (behind a login, not accessible, and not to be copied per AGENTS.md); these are Cloudlink's own designs.

**What was done** (commits a7a2227, b86f9b4, and the phase 10d commit)
- 10a/10b — `src/lib/themes.ts`, `src/server/services/branding.ts`, `src/server/services/payment-methods.ts`, settings tabs, portal/PDF instructions; migration `20261026120000_branding_payment_methods`.
- 10c — live sessions: `LiveSessionsControl`, `src/components/live.tsx`, `customerConnection`, mock `simulatedSessions`, RouterOS hotspot byte counters, `maintenance.prune`.
- 10d — AI assistant: `src/server/assistant/{model,tools,service}.ts`, portal `/portal/assistant`, staff `/support/assistant`, Settings → AI assistant; migration `20261026140000_ai_assistant` (one open chat per customer via partial unique index; role/status/source checks). Claude request: `claude-opus-5-5`, effort `low`, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), top-level `cache_control`, strict tools. Env: `ASSISTANT_ADAPTER` (default disabled; mock refused in production), `ANTHROPIC_API_KEY` (required for anthropic in production), `ASSISTANT_MODEL`, `ASSISTANT_EFFORT`, `ASSISTANT_BASE_URL` (test-only).
- Fix found by the E2E run: the worker failed to start (`react.createContext is not a function`) because server code imported a UI component file; formatters moved to `src/lib/format.ts` and a unit guard now forbids `@/components` imports under `src/server` and `src/worker`.
- Visual checks (screenshots against a production build on :3102 with the E2E database): settings tabs, themed dashboard, payment methods, live sessions (worker-synced, "Synced 12 s ago"), portal connection card, assistant chat (desktop and 390 px), staff transcript.
- Docs: `docs/PERSONALISATION.md`, `docs/ASSISTANT.md`; updates to `docs/HANDOVER.md`, `docs/DEPLOYMENT_GUIDE.md`, `docs/SECURITY_REVIEW.md`, `.env.example`.

**Commands and results (final run)**
| Command | Result |
| --- | --- |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm run test` | 15 files, 121 tests passed |
| `npm run test:integration` | 21 files, 167 tests passed (assistant and live-sessions files re-run after the formatter move: 11 passed) |
| `npm run build` / `npm run build:worker` | exit 0 / exit 0 |
| `npm run test:e2e` | 23 passed (includes `assistant.spec.ts`) |
| `npm audit` | 0 vulnerabilities |

**Still mocked / blocked**
- Claude: no API key — test mode and fake-server tests only. Customer data sent to Anthropic must be covered by the privacy review.
- Live sessions on real routers depend on the RouterOS verification already pending from phase 7.

**Exact next task**: with an Anthropic API key, run the staging check in `docs/ASSISTANT.md` → Testing, and record it here; otherwise continue with the phase 9 next tasks (M-Pesa sandbox, real router, deployment).

## Resume instruction
When resuming, inspect Git status, read this checklist and recent work log, verify the current app state, and continue from the first incomplete item. Do not repeat completed work unless a regression requires it.

Local services: `npm run db:local:start` (PostgreSQL :5433) and start Redis from `.local/redis/Redis-8.10.2-Windows-x64-msys2/redis-server.exe --bind 127.0.0.1 --port 6379` if needed.
