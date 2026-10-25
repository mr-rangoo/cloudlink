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

## Phase 2 — CRM, catalogue and subscribers
- [ ] Leads and activity timeline.
- [ ] Packages and pricing.
- [ ] Subscribers and contacts.
- [ ] Subscription lifecycle.
- [ ] CSV import preview and validation.
- [ ] Database-backed dashboard.

## Phase 3 — Billing and finance
- [ ] Invoice engine and immutable line snapshots.
- [ ] Recurring billing job and deduplication.
- [ ] Partial/full payment allocations.
- [ ] Manual cash and bank payments.
- [ ] Ledger/reconciliation.
- [ ] Credit notes, refunds and reversals.
- [ ] PDF invoices and receipts.

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

**Exact next task**: Phase 2 — add Prisma models + migration for Package, Subscriber (contacts/addresses/activity), Subscription (+events), Lead (+activity); implement services with tenant scoping, API routes, and UI (packages → subscribers → subscriptions → leads), then CSV import preview and DB-backed dashboard KPIs.

## Resume instruction
When resuming, inspect Git status, read this checklist and recent work log, verify the current app state, and continue from the first incomplete item. Do not repeat completed work unless a regression requires it.

Local services: `npm run db:local:start` (PostgreSQL :5433) and start Redis from `.local/redis/Redis-8.10.2-Windows-x64-msys2/redis-server.exe --bind 127.0.0.1 --port 6379` if needed.
