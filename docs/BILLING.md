# Cloudlink — Subscription and Billing Rules

This document records the business rules implemented in code. Update it whenever the rules change.

## Packages
- Price is stored as `NUMERIC(14,2)` in the organization currency (KES by default), excluding tax.
- `taxRate` is a percentage (e.g. `16.00` for VAT). `0` means no tax.
- Billing interval = `billingUnit` (HOUR, DAY, WEEK, MONTH, YEAR) × `billingCount`.
- Changing a package affects **new** subscriptions only. Archiving is blocked while live subscriptions use the package.

## Subscription snapshot
When a subscription is created it copies the package name, service type, price, currency, tax rate and interval.
Later package edits never change existing subscriptions or their invoices.

## Lifecycle (billing status only)
| Action | From | To |
| --- | --- | --- |
| activate | PENDING | ACTIVE |
| renew | PENDING, ACTIVE, SUSPENDED, EXPIRED | ACTIVE |
| suspend (reason required) | ACTIVE | SUSPENDED |
| reactivate | SUSPENDED (paid period not ended) | ACTIVE |
| cancel | PENDING, ACTIVE, SUSPENDED, EXPIRED | CANCELLED (terminal) |
| expire (system) | ACTIVE, SUSPENDED after period end + grace days | EXPIRED |

Every action runs in a transaction under a row lock (`SELECT … FOR UPDATE`), writes a `SubscriptionEvent`
and a subscriber timeline entry, and is audited. Network provisioning status is separate (phase 7).

## Billing periods
- Period *k* spans `[boundary(k), boundary(k+1))`, where boundaries are computed from the anchor
  (`billingAnchorAt`) — never from the previous boundary — so month-end dates do not drift.
- MONTH/YEAR keep the anchor's local day-of-month, clamped to the month length:
  31 Jan → 28 Feb (29 in leap years) → 31 Mar → 30 Apr. A 29 Feb yearly anchor bills on 28 Feb and returns to 29 Feb in leap years.
- DAY/WEEK keep the local wall-clock time in the organization timezone (default Africa/Nairobi).
- HOUR adds exact elapsed time.
- `nextBillingAt` is set to the end of the current period (invoicing rules arrive in phase 3).

## Renewal policy
- If the subscription is ACTIVE or SUSPENDED and its current period has not ended, renewal continues seamlessly:
  the next period starts exactly at the current period end.
- Otherwise (PENDING, EXPIRED, or a lapsed period) service restarts with a new anchor at the time of renewal.
- Renewals are idempotent: callers supply a key (`Idempotency-Key` header → `api:<key>`, payments will use
  `payment:<id>`). The key is stored on the `SubscriptionEvent` with a unique constraint, so retries and
  duplicate callbacks cannot extend service twice, even concurrently.

## Expiry
The worker schedules `subscriptions.expire_due` once per organization per hour (deduplicated by time bucket).
It expires ACTIVE/SUSPENDED subscriptions where `currentPeriodEnd + graceDays <= now`.

## Dashboard metric definitions
| Metric | Definition |
| --- | --- |
| Subscribers | Non-archived subscriber accounts in the caller's scope (organization, branch restriction, branch filter). |
| New this month | Subscribers created since the start of the current calendar month in the organization timezone. |
| Active / pending / suspended / expired | Subscriptions by current billing status. |
| Expiring in 7 days | ACTIVE subscriptions whose paid period ends within the next 7 days. |
| Recurring revenue (monthly) | Sum of ACTIVE subscription snapshot prices normalised to one month (yearly ÷ 12, weekly × 52 ÷ 12, daily × 365 ÷ 12, hourly × 8760 ÷ 12), excluding tax, per currency. |
| Open leads | Leads not in WON or LOST. |
| Converted this month | Leads converted since the start of the current month. |

Metrics a user lacks permission for are hidden, not estimated. Invoice, payment and receivable metrics appear with phase 3.

## Subscriber CSV import
Preview validates every row (format, branch, package, duplicates within the file and against existing subscribers)
and stores the validated rows. Commit is allowed only when there are zero errors, and creates all rows in one
transaction: either every row is imported or none is. Imported subscriptions start as PENDING.
