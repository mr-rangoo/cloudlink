# Cloudlink — Architecture Decisions

Modular monolith: one Next.js application (UI + `/api/v1`) and one separately runnable worker, sharing domain services.

## Stack (pinned in package.json / package-lock.json)
| Concern | Choice |
| --- | --- |
| Web | Next.js 16 (App Router, Turbopack), React 19, TypeScript 5.9 |
| UI | Tailwind CSS 4, Radix primitives in shadcn-style local components, Framer Motion, lucide icons, Recharts |
| Data | PostgreSQL 16+ via Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`) |
| Jobs | BullMQ 6 on Redis, with PostgreSQL as the durable source of truth |
| Validation | Zod 4 (also generates the OpenAPI 3.1 document) |
| Logging | Pino with mandatory redaction |
| Tests | Vitest 4 (unit + integration against a real `_test` database), Playwright |

TypeScript 7 (native) and Prisma 8 RC were available but not adopted: tooling compatibility (typescript-eslint, Next type plugin) and release stability.

## Source layout
```
src/app/            routes: (staff) pages, login, /api/v1 route handlers
src/components/     ui/ (design-system primitives), shell/ (app chrome)
src/lib/            client-safe helpers (formatting, navigation catalogue, API client)
src/server/         server-only code
  api/              route wrapper (auth, permissions, validation, error envelope), OpenAPI
  auth/             sessions, login, permission catalogue, staff context, page guards
  audit/            audit log writer with metadata redaction
  db/               Prisma client (UTC sessions)
  integrations/     adapters: messaging, storage, network (mock / RouterOS API / disabled), radius (FreeRADIUS SQL)
  jobs/             durable operations, BullMQ dispatch, handler registry, recurring scheduler
  observability/    logger, health checks
  security/         crypto (scrypt, AES-256-GCM), PostgreSQL rate limiter
  services/         domain services (organizations, …)
src/worker/         worker entrypoint
prisma/             schema, migrations, seed
tests/              unit/, integration/, e2e/
```

## Authentication and sessions
- Own session implementation (TRD allows "Auth.js or equivalent"): random 256-bit token in an HTTP-only, SameSite=Lax cookie
  (`__Host-` prefixed and Secure in production); only its SHA-256 hash is stored in `Session`.
- Passwords: scrypt (N=16384, r=8, p=1) via Node's crypto. No native dependency.
- Login is throttled per IP and per email (PostgreSQL fixed-window limiter), accounts lock for 15 minutes after 5 failures,
  error messages are generic, and every success/failure is audited. A successful sign-in gives its per-IP unit back, so only
  failures accumulate: staff sharing one office NAT address are not locked out, while password guessing is still throttled.
- Sessions are invalid immediately when the user is disabled, the membership is deactivated, the session is revoked or expired.
  Permissions are re-resolved from the database on every request, so role changes take effect at once.

## Tenancy and authorization
- `Organization` → `Branch`; users join organizations through `Membership` (roles + optional branch restriction).
- Every protected handler builds a `StaffContext` (organization, permissions, branch scope) server-side.
  Services take the context first and use `tenantWhere(ctx)` / `assertBranchAccess(ctx, branchId)`.
- Branch-restricted members only see records assigned to their branches (records without a branch are hidden from them).
- Roles are per-organization copies of templates in `src/server/auth/permissions.ts` and remain editable.
- CSRF: cookie-authenticated mutations require a same-origin `Origin`/`Referer` header; SameSite=Lax is the second layer.

## API conventions
`staffRoute` / `publicRoute` wrappers provide: correlation ID (`x-correlation-id`), Zod validation of params/query/body,
permission checks, optional mandatory `Idempotency-Key`, 1 MB body limit, and the error envelope
`{ error: { code, message, correlationId, fields? } }`. Unexpected errors are logged (redacted) and returned as `INTERNAL_ERROR`.
OpenAPI: `GET /api/v1/openapi.json`.

## Background processing
1. Domain code writes a `BackgroundOperation` row (optionally in the same transaction as the business change, with a `dedupeKey`).
2. After commit it dispatches the row id to BullMQ (`jobId` = row id).
3. The worker claims rows atomically (`UPDATE … WHERE status IN (…) RETURNING`), runs the idempotent handler, and records the
   real outcome. Retryable failures back off exponentially; permanent failures and exhausted retries become `DEAD`.
4. A PostgreSQL sweeper re-runs due/failed rows and reclaims `RUNNING` rows whose lease expired (crashed worker).
Redis therefore never holds financial or operational truth.

## Payments and webhooks
Payment requests (`PaymentAttempt`) never record money. Provider callbacks arrive on per-request secret URLs, are
stored once in `WebhookEvent` (deduplicated, minimised), checked against the request, verified with a provider status
query, and only then turned into a `Payment` in one transaction with its ledger posting, allocations and renewals.
Gateways are adapters behind `PaymentGateway`. Details: `docs/PAYMENTS.md`.

## Network operations
Router and RADIUS changes are `NetworkOperation` rows with an allowlisted type, written in the same transaction as the
business change (for example a suspension), and executed by the worker through a `network.execute` background job.
Every attempt is logged append-only; transient failures retry with backoff, permanent ones fail at once, and both raise
alerts when final. Only the worker connects to routers, over private or VPN addresses. Details: `docs/NETWORK.md`.

## Time and money
- All timestamps are `timestamptz`; database sessions are pinned to UTC (found necessary: the adapter sends offset-less
  timestamps, which a non-UTC server would shift). Business schedules use the organization timezone (default Africa/Nairobi).
- Money: PostgreSQL `NUMERIC` / Prisma `Decimal`, always with a currency column; never JavaScript floats.

## Observability
- `/api/v1/health/live` (process up) and `/api/v1/health/ready` (config + database required; Redis reported).
- Worker heartbeat rows (`WorkerHeartbeat`) surface on the dashboard.
- Pino JSON logs with redaction of passwords, tokens, cookies, passkeys, secrets and phone numbers.
