# Cloudlink — Database Design and Invariants

This document defines the minimum domain model. The implementation agent must turn it into a normalized Prisma schema, migrations, indexes and tests. Adjust model names as needed but preserve the invariants.

## 1. Organization and identity
- `Organization`: id, name, slug, currency, timezone, status, createdAt.
- `Branch`: id, organizationId, name, code, address, status.
- `User`: id, organization scope where applicable, name, email/phone, status, authentication reference.
- `Role`, `Permission`, `UserRole`, `RolePermission`.
- Session/account models required by the selected auth provider.

## 2. CRM and subscriber
- `Lead`: organizationId, branchId, contact details, source, stage, ownerId.
- `LeadActivity`: leadId, actorId, event type, notes, createdAt.
- `Subscriber`: organizationId, branchId, accountNumber, identity/contact data, status.
- `SubscriberContact`, `SubscriberAddress`, `SubscriberActivity`.
- `Package`: organizationId, name, serviceType, price, currency, interval, speed/quota/device limits, status.
- `Subscription`: organizationId, subscriberId, packageId, status, startsAt, endsAt, nextBillingAt, grace policy, commercial snapshot.
- `SubscriptionEvent`: subscriptionId, event type, actor, metadata, timestamp.

## 3. Billing and finance
- `Invoice`: organizationId, branchId, subscriberId, subscriptionId where applicable, invoiceNumber, status, currency, subtotal, tax, total, amountPaid/derived balance policy, issuedAt, dueAt, billingPeriodStart/end, idempotency key.
- `InvoiceLine`: invoiceId, description snapshot, quantity, unit price, tax/discount snapshot, line total.
- `CreditNote`, `CreditNoteLine`.
- `Payment`: organizationId, subscriberId, provider, providerTransactionId, internalReference, amount, currency, status, receivedAt, metadata with sensitive fields excluded.
- `PaymentAllocation`: paymentId, invoiceId, amount.
- `LedgerTransaction`: organizationId, type, reference, actor/system source, timestamp.
- `LedgerEntry`: transactionId, account/category, debit/credit or signed amount according to the chosen ledger design, currency.
- `Refund`, `Expense`, `Withdrawal`, `ReconciliationRecord`.

## 4. Network
- `Router`: organizationId, branchId, name, management address/reference, RouterOS compatibility, connection mode, status.
- `RouterCredential`: encrypted credential payload or external secret reference; never plaintext.
- `NetworkSession`: subscriberId, routerId, session identifiers, start/end, usage counters, source.
- `NetworkOperation`: organizationId, subscriberId, routerId, operation type, requested state, status, idempotency key, requestedBy, timestamps.
- `NetworkOperationAttempt`: operationId, attempt number, outcome, safe error code, timestamp.
- `RadiusAccount`: identity mapping and provisioning status; do not duplicate plaintext secrets.
- `NetworkUsageRecord`, `RouterAlert`.

## 5. Voucher and support
- `VoucherBatch`, `Voucher`, `VoucherRedemption`, `AgentCommission`.
- `SupportTicket`, `TicketComment`, `TicketAttachment`.
- `Notification`, `NotificationTemplate`, `NotificationPreference`.

## 6. Integration and operations
- `IntegrationConfiguration`: provider, organizationId, status, safe config, secret reference.
- `WebhookEvent`: provider, event key/fingerprint, received payload after safe redaction/minimization, processing status, timestamps.
- `IdempotencyRecord`: scope, key, request hash, response/result reference, status.
- `BackgroundOperation`: operation type, status, attempt count, safe error, correlation ID.
- `AuditLog`: actor, organization, action, entity type/id, safe before/after metadata, IP/user-agent where justified.
- `ImportJob`, `ExportJob`.

## 7. Required invariants
1. All tenant-owned records have an organization relationship and queries are tenant-scoped.
2. Unique invoice number within the defined organization scope.
3. Unique invoice generation key for subscription + billing period.
4. Unique provider transaction ID within provider scope when supplied.
5. Monetary values use decimal-safe types and include currency.
6. Payment allocations are positive and cannot exceed allocatable funds.
7. Issued invoice lines are immutable snapshots.
8. Refunds, credit notes and reversals create auditable records.
9. Duplicate callbacks cannot create duplicate payments, allocations or renewals.
10. Voucher redemption is atomic and concurrency-safe.
11. Network operations have durable idempotency keys and status history.
12. Credentials are encrypted or stored in a managed secret store.
13. Deactivation/archive must preserve required financial audit history.
14. Multi-record financial writes use database transactions.
15. Do not rely solely on cached balances as financial truth.

## 8. Ledger guidance
Choose and document a consistent accounting representation. Prefer balanced double-entry entries if implementing a formal ledger; otherwise clearly define a transaction journal and reconciliation rules. Never silently mutate completed transactions. Provide correction entries and auditable reversals.

## 9. Indexes
Add indexes for common tenant-scoped lookups:
- organizationId + createdAt/status.
- subscriber account number and normalized contact fields.
- invoice number/status/due date/subscriber.
- payment provider transaction ID/status/receivedAt.
- subscription status/nextBillingAt.
- voucher code hash/status/expiry.
- network operation status/createdAt/router.
- webhook event key/status.
- audit organization/entity/actor/time.

Avoid storing plaintext voucher codes where a hash can support lookup safely; only reveal generated codes to authorized users at creation or through a controlled export.
