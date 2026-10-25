# Cloudlink — Technical Requirements Document (TRD)

## 1. Preferred stack
- Next.js, React, TypeScript.
- Tailwind CSS and shadcn/ui.
- Framer Motion for restrained motion.
- Recharts for analytics.
- PostgreSQL and Prisma.
- Redis and BullMQ.
- Zod validation.
- Auth.js or equivalent secure session-based authentication.
- Vitest and Playwright.
- Docker Compose for local services.
- OpenAPI for REST documentation.
- Pino or equivalent structured logger.

Use maintained compatible versions, a single package manager, and a committed lockfile. If the repository already has a sound architecture, document and preserve it rather than rewriting blindly.

## 2. Architectural boundaries
Suggested domains:
- identity
- organizations
- crm
- subscribers
- catalogue
- subscriptions
- billing
- payments
- ledger
- vouchers
- network
- radius
- support
- notifications
- reporting
- integrations
- audit
- jobs

Each domain should have clear schemas, service logic, validation and tests. Keep business rules out of React components and route handlers.

## 3. Runtime processes
- Web: Next.js server and API.
- Worker: BullMQ processors using shared domain services.
- PostgreSQL: source of truth.
- Redis: queue and short-lived coordination, not the sole store for financial truth.
- Object storage: generated PDFs, approved attachments and exports.
- Integration adapters: server-side provider boundaries.

## 4. API conventions
- Prefix: `/api/v1`.
- JSON requests/responses.
- Zod validation.
- Consistent error envelope with stable error code, safe message and correlation ID.
- Pagination for collection endpoints.
- Explicit sort/filter allowlists.
- Server-side organization and role scoping.
- OpenAPI documentation.
- Rate limits on authentication, payment initiation and public webhooks as appropriate.

## 5. Data and money
- PostgreSQL `NUMERIC` and Prisma `Decimal` for money.
- Explicit currency on financial records.
- UTC timestamps; business schedule calculations use `Africa/Nairobi`.
- Transactional writes for invoices, allocations, refunds and ledger operations.
- Unique constraints for idempotency and provider references.
- Versioned migrations.
- No destructive production schema resets.

## 6. Background processing
Use BullMQ for billing, reminders, webhook processing, exports, notifications and network operations. Persist durable operation/event records in PostgreSQL. Jobs must be idempotent, observable, retry-limited and safe after worker restarts. Use database uniqueness constraints or distributed coordination for scheduled tasks.

## 7. Suggested source layout
Adapt to the chosen framework and existing repository:

```text
src/
  app/
  components/
  features/
    crm/
    subscribers/
    packages/
    subscriptions/
    billing/
    payments/
    network/
    vouchers/
    support/
    reports/
  server/
    auth/
    db/
    services/
    integrations/
    jobs/
    security/
    observability/
  lib/
  tests/
prisma/
  schema.prisma
  migrations/
docs/
```

Keep secrets and provider SDKs server-only.

## 8. Observability
Provide:
- Liveness and readiness endpoints.
- Structured logs.
- Correlation/request IDs.
- Queue failure visibility.
- Integration health/status.
- Error monitoring hooks.
- Alerts for failed payment processing, stuck network operations and job backlogs.

Never include passwords, tokens, passkeys, shared secrets or unnecessary personal data in logs.
