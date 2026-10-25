# Cloudlink — Testing Strategy

## Test layers
- Unit: domain calculations, state transitions and validation.
- Integration: PostgreSQL, service layer, queues and provider mocks.
- API: authentication, authorization, validation, tenant scoping and error contracts.
- E2E: real user workflows through the browser.
- Operational: migration, health checks, backup/restore and release smoke tests.

## Required unit tests
- Decimal invoice totals and rounding.
- Discounts and tax configuration.
- Month-end and leap-year billing periods.
- Idempotent invoice generation.
- Partial and full payment allocation.
- Allocation limits.
- Credit notes, refunds and reversals.
- Duplicate and replayed payment callbacks.
- Renewal idempotency.
- Voucher expiry and concurrent redemption.
- Authorization and tenant scoping.
- CSV import validation.
- Network operation retry classification.

## Required integration tests
- Create subscriber/package/subscription.
- Generate and issue invoice.
- Record manual cash/bank payment.
- Allocate payment and reconcile balance.
- Process duplicate mock M-Pesa callback exactly once.
- Reject invalid amount/reference.
- Process failed or delayed provider status safely.
- Queue a network operation and retry a transient mock failure.
- Enforce customer record ownership.
- Enforce organization/branch isolation.
- Audit sensitive operations.

## Required Playwright flows
1. Staff login and logout.
2. Create package.
3. Create subscriber and activate subscription.
4. Generate invoice.
5. Record a manual payment.
6. View invoice balance and receipt.
7. Customer views their own invoice.
8. Customer cannot view another customer's invoice.
9. Authorized accountant reconciles a payment.
10. Unauthorized staff cannot issue a refund or execute a router action.
11. Router mock failure is visible and retried according to policy.

## Commands
Document and implement scripts for:
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run build`

Run the relevant suites after each phase and the complete set before release. Do not report tests as passed unless they actually ran and passed.

## Test data
Use an isolated test database and deterministic fictional fixtures. Never use production data or live payment credentials in automated tests.
