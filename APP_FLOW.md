# Cloudlink — Application and Business Flows

## 1. Staff login
Open Cloudlink → authenticate → load organization/branch context → resolve permissions → render allowed navigation → log security-sensitive events.

## 2. Lead conversion
Create lead → validate duplicate/contact data → assign salesperson → update sales stage → convert in a transaction → create subscriber and initial activity → preserve lead history → audit conversion.

## 3. Subscriber onboarding
Create subscriber → select branch → select package → validate package eligibility → create subscription → record activation event → queue network provisioning if configured → display actual provisioning status.

## 4. Recurring billing
Scheduler selects due subscriptions → acquire safe deduplication guard → calculate billing period and amounts → create invoice and immutable lines transactionally → enqueue notification → update job status. Retried jobs must not duplicate invoices.

## 5. M-Pesa payment
Customer requests payment → server creates pending payment attempt → server calls Daraja adapter → customer completes payment on device → provider callback reaches HTTPS endpoint → validate and persist event → deduplicate → process payment → allocate funds → update invoice balance → queue renewal/network action according to policy → issue receipt → notify customer. Browser redirects never confirm payment.

## 6. Manual/bank payment
Authorized staff selects subscriber/invoice → enters method, amount, date and reference → server validates permission and amount → create payment and allocation transactionally → audit action → issue receipt. High-risk adjustments require additional permission or approval policy.

## 7. Reconciliation
Import or receive provider/bank records → match by provider reference/account/amount/date → classify matched, unmatched or exception → authorized review → allocate or reverse using auditable operations → produce reconciliation report.

## 8. Subscription renewal and network operation
Payment confirmed or authorized renewal initiated → evaluate billing policy → renew subscription idempotently → persist network operation → enqueue job → adapter executes approved operation → store actual result → verify state when supported → notify subscriber. Billing renewal and network success remain separate statuses.

## 9. Suspension
Policy identifies overdue/expired subscription → verify grace period and exceptions → create auditable suspension decision → queue router/RADIUS operation → store result → notify customer. Do not suspend accounts protected by configured exceptions or unresolved payment-processing states.

## 10. Voucher redemption
Customer selects package → payment is confirmed or authorized voucher is supplied → validate voucher status, expiry, use limit and network policy → redeem atomically → queue session activation → record result → show actual activation status.

## 11. Customer self-service
Customer authenticates → server resolves subscriber identity → fetch only owned records → customer views invoices/payments → starts payment → sees pending/confirmed status from server records → opens support ticket if needed.

## 12. Support
Customer or staff creates ticket → permission and ownership validation → assign priority and staff → notify permitted parties → update status/comments → preserve timeline → resolve and record resolution.

## 13. Reports and exports
Authorized user chooses report and filters → server validates scope → query consistent records → calculate metrics → return paginated data or queue export → create time-limited download link → audit export.

## 14. Error and recovery flows
- Provider timeout: keep pending/unknown state until safely reconciled; do not assume failure or success.
- Duplicate webhook: return a safe acknowledgement after durable deduplication.
- Worker crash: resume durable jobs without duplicate side effects.
- Router offline: record failed/unconfirmed operation, retry eligible failures, alert staff.
- Notification failure: retry under policy without reversing a valid payment.
- Import errors: provide row-level errors and avoid partial commits unless explicitly designed and documented.
