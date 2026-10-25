# Cloudlink — Reports and Administration

## Reports (`/reports`)
All financial reports read the double-entry ledger, so they always agree with the books (verified in
`tests/integration/admin-reports.test.ts`). Months are calendar months in the organization timezone; the range is
limited to 36 months (default: last 12).

| Report | Definition |
| --- | --- |
| Revenue | Credits − debits on Service revenue (4000): invoices issued, less voids |
| Credit notes | Debits − credits on Credit notes and allowances (4100) |
| Net revenue | Revenue − credit notes, excluding tax |
| Tax | Net credits on Tax payable (2200) |
| Collected | Debits to cash/bank/M-Pesa from payment receipts, less refunds and payment reversals |
| Expenses | Net debits on Operating expenses (5000) |
| Receivables aging | Open invoice balances by days past due (not yet due, 1–30, 31–60, 61–90, 90+). Total equals the AR account |
| Subscribers | New accounts per month; activations, renewals, suspensions, expiries and cancellations from subscription events; active subscriptions and monthly-equivalent revenue by package |
| Collections by method | Confirmed (non-reversed) payments by month and method, before refunds |

Charts follow the data-viz rules: single y-axis, fixed series colour order validated for colour-vision deficiency in
light and dark mode, legend for ≥ 2 series, hover tooltips, and a data table under every chart.

## Exports
- Types: subscribers, invoices, payments, receivables aging, revenue, audit log.
- Requires `reports.export` **and** read permission for the data. Requests are audited and queued; the worker
  re-checks the requester's live membership and permissions before generating the CSV (a deactivated user's queued
  export fails).
- CSV cells are neutralised against spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes).
- Files are stored via the storage adapter; the download link (`/api/v1/exports/:id/download`, authenticated) works
  for 24 hours, then the file is deleted and the job marked EXPIRED. Every download is audited.

## Staff and permissions (`/staff`)
- Invite: new users get a **single-use setup link** (72 h, only its hash stored, shown once to the inviter). Existing
  Cloudlink users are simply added to the organization.
- Edit roles, branch scope or status; any such change revokes that member's sessions in the organization.
- Guards: you cannot change your own roles or deactivate yourself; only owners can grant the owner role or change
  owners; the organization always keeps at least one active owner; branch-restricted admins cannot grant access
  beyond their own branches.
- Password reset: administrators issue a one-time reset link; completing it revokes all of that user's sessions.
- Roles: the owner role always has every permission (locked). Built-in roles can be edited but not deleted; custom
  roles can be created and deleted when unused. Permission changes apply on the next request. High-risk permissions
  are flagged in the editor.

## Branches, settings, audit
- Branch archive is blocked while subscribers are assigned.
- Settings: display name, business timezone, invoice details (legal name, address, tax PIN), number prefixes, invoice
  lead time, payment terms, invoice-on-activation. Currency is shown but fixed once invoices exist. Prefix changes
  affect newly issued documents only.
- Audit log search by action prefix, entity, actor and date range; exportable.

## Inventory (`/inventory`)
Statuses IN_STOCK → ASSIGNED (needs a subscriber, enforced by a DB CHECK) → returned; any non-retired item can be
marked FAULTY; repaired → IN_STOCK; RETIRED is terminal. Every change is an `InventoryMovement` and assignment changes
appear on the subscriber timeline. Serial numbers are unique per organization.

## Integrations (`/integrations`)
Shows each provider's real status: `mock`, `not_configured`, `sandbox_tested`, `production_verified` or `error`.
Tested/verified states come only from recorded real tests (phases 7–8). Secrets are never displayed.
