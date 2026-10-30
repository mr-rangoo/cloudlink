# Cloudlink — Subscription and Billing Rules

This document records the business rules implemented in code. Update it whenever the rules change.

## Packages
- Price is stored as `NUMERIC(14,2)` in the organization currency (KES by default), excluding tax.
- `taxRate` is a percentage (e.g. `16.00` for VAT). `0` means no tax.
- Billing interval = `billingUnit` (MINUTE, HOUR, DAY, WEEK, MONTH, YEAR) × `billingCount`. Minutes are for hotspot plans only; the maximum count per unit is MINUTE 1440, HOUR 720, DAY 365, WEEK 104, MONTH 60, YEAR 10.
- Changing a package affects **new** subscriptions only. Archiving is blocked while live subscriptions use the package.
- Plan type = access technology (`serviceType`) + what it grants (`kind`): TIME (unlimited data for the duration), DATA (a data bundle, `dataQuotaMb` required), TRIAL (may be free; `trialCooldownDays`), DEVICE (TV/streaming device by MAC). DATA, TRIAL and DEVICE plans are hotspot plans.
- Price must be greater than zero, except for TRIAL plans.
- Availability: **Live** (`ACTIVE`, `listed`) is sold to customers; **Hidden** (`ACTIVE`, not listed) is not shown to customers but staff can assign it; **Off** (`INACTIVE`) cannot be sold. A plan can carry a label (`POPULAR` or `OFFER`) and a display order.
- Burst (all five values or none) must satisfy burst limit > rate limit > burst threshold in both directions. A fair use policy needs a usage limit and an action; throttling needs reduced rates below the plan rates. A schedule window (local time, may cross midnight) names the days it starts on.
- A PATCH changes only the fields it sends; switching a policy off clears its dependent values.
- Revenue 30d on the plans page = fully paid invoice lines for the plan (gross, `paidAt` in the last 30 days) + face value of the plan's vouchers redeemed in the last 30 days, within the viewer's branch scope; shown only to staff with `payments.read` or `reports.read`.

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
- MINUTE and HOUR add exact elapsed time.
- `nextBillingAt` is the end of the current period; the next invoice is generated up to `invoiceLeadDays` before it.
- `invoicedThrough` is the end of the latest period that has an invoice, so a period is never invoiced twice.

## Renewal policy
- If the subscription is ACTIVE or SUSPENDED and its current period has not ended, renewal continues seamlessly:
  the next period starts exactly at the current period end.
- Otherwise (PENDING, EXPIRED, or a lapsed period) service restarts with a new anchor at the time of renewal.
- Renewals are idempotent: callers supply a key (`Idempotency-Key` header → `api:<key>`, payments will use
  `payment:<id>`). The key is stored on the `SubscriptionEvent` with a unique constraint, so retries and
  duplicate callbacks cannot extend service twice, even concurrently.

## Compensation (free time)
Staff with `subscriptions.write` can add free hours or days (up to 90 days at a time, with a reason) to an ACTIVE or
SUSPENDED subscription, for example after an outage: subscriber page → **Compensate**, or
`POST /subscriptions/:id/compensate` with an `Idempotency-Key` (a retried request never adds the time twice).
- The paid period end moves forward; no invoice, payment or ledger entry is created.
- Billing is re-anchored at the new end: `billingAnchorAt = currentPeriodEnd` and `periodIndex = -1`, so the next
  regular period (index 0) starts exactly at the compensated end, for renewals and recurring invoices alike.
- An invoice already issued for the next period keeps its printed dates; when it is paid, the renewal still starts at
  the compensated end and runs a full period.
- Hotspot logins get the longer period pushed to the router. Data bundles are refused (time does not compensate a data
  allowance).
- Recorded as a `compensated` subscription event, a subscriber activity entry and an audit record.

## Expiry
The worker schedules `subscriptions.expire_due` once per organization every minute (deduplicated by time bucket).
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
| Collected today / yesterday | CONFIRMED payments in the organization currency by local day. "By now" compares today with yesterday up to the same time of day. |
| Collections, 14 days | The same, per local day for the last 14 days. |
| Online now | ACTIVE subscriptions with network access (a login username) that have a session open now, out of all such subscriptions. |
| Expiring in 24 hours | ACTIVE subscriptions whose paid period ends within the next 24 hours. |
| Invoices due in 3 days | OPEN or PARTIALLY_PAID invoices with a due date in the next 3 days. |
| Expired in 7 days, not renewed | EXPIRED subscriptions whose period ended in the last 7 days. |
| Busiest routers | Routers with the most open sessions now, with their 24-hour health score (see `docs/NETWORK.md`). |

Metrics a user lacks permission for are hidden, not estimated. The overview re-reads its data every minute.

### Subscriber list figures and filters
- **Online now**: subscribers with a session open now (sessions are matched to subscribers at each sync). **Active but offline**: an ACTIVE subscription with network access and no open session.
- **At risk**: an ACTIVE subscription ending within 3 days, or one that expired in the last 7 days.
- Filters: subscription status, service (PPPoE, hotspot, static IP, other), connection, router, joined in the last 7/30/90 days, VIP, at risk. Each row shows the router, and "Online" or when the subscriber was last seen online.

### Record search (Ctrl+K)
Searches, with two or more characters: subscribers (name, account number, email, phone), invoices (number), payments (receipt number, M-Pesa or bank reference, payer name), routers (name, identity, address), support tickets (number, subject) and leads (name, phone). Each kind is searched only with its read permission and within the caller's branch scope; at most five hits each.

## Subscriber CSV import
Preview validates every row (format, branch, package, duplicates within the file and against existing subscribers)
and stores the validated rows. Commit is allowed only when there are zero errors, and creates all rows in one
transaction: either every row is imported or none is. Imported subscriptions start as PENDING.

## Invoices
- Created as DRAFT with all lines, then issued (DRAFT → OPEN). Issuing assigns a gapless per-organization number
  (`INV-000001`; the counter increments inside the issuing transaction, so a rollback leaves no gap), sets the due date,
  posts the ledger entry, and immediately applies any customer credit.
- Line math: `subtotal = round2(qty × unit price)`, discount is applied before tax, `tax = round2(taxable × rate / 100)`,
  rounding half-up per line; invoice totals are sums of rounded lines. Prices are tax-exclusive.
- Due date = end of the local day (organization timezone) of max(issue date, period start) + `paymentTermsDays`.
  "Overdue" is derived (open balance and due date passed), never stored.
- Issued invoices are immutable (database triggers): lines, amounts, currency, customer and number cannot change and the
  invoice cannot be deleted. Corrections use credit notes, or void (only with no payments/credits applied; the ledger
  posting is reversed and the number is kept).
- Settlement cache: `amountPaid`, `amountCredited`, `balanceDue` with a CHECK constraint
  `balanceDue = total − amountPaid − amountCredited`. Reconciliation recomputes them from allocations and credit notes.

## Recurring billing (prepaid)
- Activation invoices the first period (organization setting `invoiceOnActivation`, default on).
- The worker runs `billing.run_recurring` hourly per organization: every ACTIVE, auto-renewing subscription whose period
  ends within `invoiceLeadDays` (default 3) gets an invoice for the next period. Generation key
  `sub:<subscriptionId>:<periodStartISO>` is unique per organization, and the subscription row is locked, so repeated or
  concurrent runs create exactly one invoice per period.
- When a period invoice becomes fully PAID the subscription renews with idempotency key `invoice:<invoiceId>`:
  continues seamlessly if still running, or restarts from the payment time if it had lapsed/expired.
  Paying an invoice for a period already covered (e.g. activation) changes nothing. Suspended or cancelled
  subscriptions are never renewed automatically.

## Payments
- Manual payments (cash, bank, cheque, card, manually verified M-Pesa) are CONFIRMED on entry and get a gapless receipt
  number (`RCT-000001`). Non-cash entries need a reference, unique per organization (case-insensitive). A reversed manual
  payment releases its reference so the corrected entry can be recorded; gateway references stay unique forever.
- Every payment first lands in the subscriber's **customer credit**, then allocations move money to invoices.
  Allocation rules: payment CONFIRMED and matched; same subscriber and currency; amount ≤ unallocated amount and
  ≤ invoice balance; invoice OPEN/PARTIALLY_PAID. Rows are locked Payment → Invoice → Subscription to prevent races.
- Automatic allocation: oldest payment to the oldest-due open invoice (on payment entry, on invoice issue, on matching).
- Unidentified receipts (no subscriber) post to "Unidentified receipts" and appear under Reconciliation until matched.
- Mutating payment endpoints require an `Idempotency-Key`; the same key and body replays the stored response.
- Every payment records how the money arrived (`source`): **Recorded by staff** (manual entry), **M-Pesa prompt**
  (STK Push for an account or invoice), **Hotspot purchase** (STK Push from the captive portal) or **Paybill / till**
  (C2B confirmation). Set when the payment is created; payments that existed before were filled in from their linked
  M-Pesa request, otherwise from the provider.

### Payments page
- Period: today, yesterday, 7 or 30 days, this or last month, custom dates (inclusive local dates in the organization
  timezone) or all time. Filters: status, method, how the money arrived, search.
- Figures (for the period, method, type and search; not the status tab; organization currency): collected
  (CONFIRMED), by method (M-Pesa, cash, bank), unmatched (confirmed, no subscriber), credit on accounts (confirmed,
  matched, not yet allocated or refunded), and a line by how the money arrived plus reversals.
- Columns: type; **Reconciled** = Allocated (fully used by invoices), Partly allocated, Credit on account (nothing
  allocated yet) or Unmatched; **Activation** for hotspot purchases = time from the confirmed payment to access
  confirmed on the router, or "Not confirmed on router".
- **Export payments** queues a CSV of the current period, status, method and type (needs `reports.export`).

### Expenses page
- Same periods, plus category, method, status (recorded / reversed) and search.
- Figures: spent (recorded, reversals excluded), entries, largest category, change against the equally long period
  before, and — with `payments.read` — payments collected in the same period and collected minus spent (a cash view
  before tax, not profit). Spending by category with shares. **Export expenses** queues a CSV.

## Corrections
| Situation | Operation | Effect |
| --- | --- | --- |
| Wrong invoice allocated | Reverse allocation | Invoice reopens, money returns to customer credit |
| Customer overpaid / leaving | Refund (≤ unallocated) | Money leaves cash/bank/M-Pesa; refund record is append-only |
| Bounced cheque / entry error | Reverse payment | All allocations reversed, receipt marked REVERSED (kept) |
| Compensation / billing error | Credit note (≤ total − prior credits) | Reduces invoice balance; any excess becomes customer credit |
| Invoice raised in error (unpaid) | Void | Ledger posting reversed; number retained |
| Expense entered in error | Reverse expense | Reversing ledger entry |

Refunds, reversals and credit notes require `payments.refund` / `credit_notes.create` (accountant, owner).

## Ledger and reconciliation
Double-entry; the chart of accounts and every posting rule are documented in `src/server/services/ledger.ts`.
A deferred constraint trigger rejects any transaction whose debits ≠ credits; ledger rows are append-only.
**Reconciliation rule**: a subscriber's balance is AR − customer credit from the ledger. The balance checks verify that
(1) every invoice's cached paid/credited figures equal its active allocations and credit notes, (2) every payment's
cached allocated/refunded figures equal its active allocations and refunds, (3) the AR account equals the sum of open
invoice balances, and (4) total debits equal total credits. Each run is stored as a `ReconciliationRecord`.
