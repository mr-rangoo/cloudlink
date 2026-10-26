# Cloudlink: handover

Cloudlink is a multi-tenant ISP billing and network-operations platform for Kenya (KES, Africa/Nairobi). It is a Next.js web app plus a separately run worker, on PostgreSQL, with Redis optional.

## What is built (phases 1–9)
| Area | Highlights | Docs |
| --- | --- | --- |
| Foundation | Staff authentication and sessions, 47 permissions and 8 role templates, organization and branch scoping, audit log, idempotent APIs, durable background jobs, OpenAPI (`/api/v1/openapi.json`) | `docs/ARCHITECTURE.md` |
| CRM and subscribers | Leads to subscribers, packages, subscription lifecycle, CSV import, dashboard | |
| Billing and finance | Invoices, credit notes, manual payments, allocations, refunds and reversals, double-entry ledger, reconciliation, expenses and collections, PDFs | `docs/BILLING.md` |
| Customer portal and support | Portal sign-in and activation, own invoices, payments and receipts, tickets with attachments, notifications (email/SMS adapters) | `docs/PORTAL_SUPPORT_NOTIFICATIONS.md` |
| Administration and reports | Staff and roles, branches, settings, reports and CSV exports, inventory, integration status | `docs/ADMIN_REPORTS.md` |
| Hotspot vouchers | Voucher batches, agents and commissions, captive portal, activation through network operations | `docs/VOUCHERS.md` |
| Network | MikroTik RouterOS API adapter, PPPoE and hotspot operations with read-back verification, FreeRADIUS SQL provisioning, durable operations with retries and alerts, sessions, health checks, one-time router setup command | `docs/NETWORK.md` |
| Payments | M-Pesa Daraja STK Push and C2B, verified and deduplicated callbacks, payment requests for staff and portal, gateway interface | `docs/PAYMENTS.md` |
| Release | Security review, CSP and HSTS, tenant sweep, backup and restore scripts with a tested restore, Docker and compose artefacts, deployment and operations guides, smoke test | `docs/SECURITY_REVIEW.md`, `docs/DEPLOYMENT_GUIDE.md`, `docs/OPERATIONS.md` |

## What is verified, and what is not
| Integration | Status |
| --- | --- |
| PostgreSQL, Redis, worker | Verified locally (tests, production-mode smoke run) |
| M-Pesa Daraja | **Not verified.** Tested against a fake Daraja server only. Needs sandbox credentials, then production approval. |
| MikroTik RouterOS | **Not verified on hardware.** Tested against a fake RouterOS API server only. |
| FreeRADIUS | **Not verified with a live server.** Tested against compatible SQL tables. |
| Email (SMTP), SMS (Africa's Talking) | Implemented; not verified with real sends |
| Object storage | Local disk only; S3 adapter not implemented |
| Cloud deployment | Documented; **not executed** (not authorized; Docker unavailable on the build machine) |

The Integrations page shows these statuses live. It marks something tested or verified only after a real successful run.

## Run it locally
See `docs/LOCAL_SETUP.md`:
```
npm install
npm run db:migrate      # first time
npm run db:seed         # demo data (development only)
npm run dev             # http://localhost:3100
npm run worker          # in a second terminal
```

## Quality gates (last run: see IMPLEMENTATION_PLAN.md, phase 9)
```
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
npm run test:e2e
```

## What you need to provide next
1. **M-Pesa sandbox credentials:** consumer key, secret, passkey and shortcode. Enter them under Integrations → M-Pesa settings with `PAYMENT_ADAPTER=daraja`. Run one sandbox payment; the status becomes "Sandbox tested". Then get production approval and repeat.
2. **A MikroTik router reachable over a VPN** from the server, and a decision on a WireGuard hub. Then use the router's **Setup command** and follow "Testing against a real router" in `docs/NETWORK.md`.
3. **SMTP and SMS provider accounts**, if you want real messages.
4. **Hosting authorization:** an AWS (or other) account and a domain. Follow `docs/DEPLOYMENT_GUIDE.md`.
5. **Legal and privacy review** (Kenya Data Protection Act) and an **external penetration test** before going live.

## Known limitations
- No B2C refunds to M-Pesa, no C2B transaction-status verification, and no online hotspot voucher purchase.
- No S3 storage adapter, no RADIUS CoA, and no in-place `APP_ENCRYPTION_KEY` rotation.
- Session data is polled every 5 minutes. Network usage records live on sessions.

## Where things are
- **Code:** `src/server/services` (business logic), `src/server/integrations` (provider adapters), `src/app` (pages and API routes), `src/worker` (background worker).
- **Tests:** `tests/unit`, `tests/integration` (real PostgreSQL), `tests/e2e` (Playwright, real worker). Fakes live in `tests/support`.
- **Schema:** `prisma/schema.prisma`, with migrations in `prisma/migrations`.
- **Progress log:** `IMPLEMENTATION_PLAN.md`, the source of truth for what was done and verified.
