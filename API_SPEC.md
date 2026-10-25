# Cloudlink — API Specification

## Conventions
- Prefix all endpoints with `/api/v1`.
- Use JSON, Zod validation, stable error codes and correlation IDs.
- Paginate list endpoints.
- Enforce server-side authentication, authorization, organization and branch scope.
- Do not return secret fields or unrestricted ORM objects.
- Generate OpenAPI documentation from validated contracts where practical.

Example error response:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be processed.",
    "correlationId": "request-correlation-id"
  }
}
```

## Initial endpoint inventory

### Dashboard
- `GET /dashboard/summary`
- `GET /dashboard/activity`

### CRM
- `GET /leads`
- `POST /leads`
- `GET /leads/:id`
- `PATCH /leads/:id`
- `POST /leads/:id/convert`

### Subscribers
- `GET /subscribers`
- `POST /subscribers`
- `GET /subscribers/:id`
- `PATCH /subscribers/:id`
- `POST /subscribers/:id/renew`
- `POST /subscribers/:id/suspend`
- `POST /subscribers/:id/reactivate`
- `POST /subscribers/imports`
- `GET /subscribers/:id/activity`

### Packages and subscriptions
- `GET /packages`
- `POST /packages`
- `PATCH /packages/:id`
- `GET /subscriptions`
- `GET /subscriptions/:id`
- `POST /subscriptions/:id/cancel`

### Invoices
- `GET /invoices`
- `POST /invoices`
- `GET /invoices/:id`
- `POST /invoices/:id/issue`
- `POST /invoices/:id/credit-notes`
- `GET /invoices/:id/pdf`

### Payments and ledger
- `GET /payments`
- `POST /payments/manual`
- `POST /payments/:id/allocate`
- `POST /payments/:id/reconcile`
- `POST /payments/:id/refunds`
- `GET /payments/unmatched`
- `GET /ledger/entries`

### M-Pesa
- `POST /payments/mpesa/stk-push`
- `POST /webhooks/mpesa`
- `GET /payments/:id/status`

### Network
- `GET /routers`
- `POST /routers`
- `GET /routers/:id`
- `GET /routers/:id/sessions`
- `POST /routers/:id/operations`
- `GET /network/operations`
- `GET /network/operations/:id`
- `GET /network/alerts`

### Vouchers
- `GET /vouchers`
- `POST /vouchers/batches`
- `GET /vouchers/batches/:id`
- `POST /vouchers/:id/redeem`

### Customer portal
- `GET /customer/me`
- `GET /customer/invoices`
- `GET /customer/payments`
- `POST /customer/payments`
- `GET /customer/receipts/:id`
- `GET /customer/tickets`
- `POST /customer/tickets`

### Support, reports and administration
- `GET /support/tickets`
- `POST /support/tickets`
- `PATCH /support/tickets/:id`
- `GET /reports/revenue`
- `GET /reports/receivables`
- `GET /reports/subscribers`
- `GET /audit-logs`
- `GET /integrations`
- `PATCH /integrations/:id`

## API safety rules
- Validate route IDs and body schemas.
- Apply allowlisted sorting and filtering.
- Never accept arbitrary database fields.
- Require idempotency keys for operations where retries can create side effects.
- Rate-limit login, payment initiation, public voucher redemption and webhook endpoints appropriately.
- Use provider-specific webhook authenticity checks and durable deduplication.
- Return generic safe errors to clients and detailed redacted logs to operators.
- Generate endpoint-level authorization tests.
