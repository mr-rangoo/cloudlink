# Cloudlink — Customer Portal, Support and Notifications

## Customer portal
- URL: `/portal/<provider-code>/login` (provider code = organization slug). `/portal` remembers the last provider.
- Customers sign in with **phone number or account number** plus a password. Customer accounts are separate from
  staff users (`CustomerAccount`, `CustomerSession`, cookie `cloudlink_portal`, `__Host-` prefixed in production).
- Setup: staff open the subscriber and either **Send invite** (SMS/email; the single-use token is minted by the worker at
  send time, so it is never stored in plaintext — the stored message shows `[secure link sent - not stored]`) or
  **Create setup link** (shown once to staff for direct hand-over). Links expire after 72 hours; the newest link
  invalidates older ones; setting a password revokes existing portal sessions. "Send password reset" reuses the flow.
- Protections: login throttling per IP and identifier, lockout after 5 failures (15 minutes), generic error messages,
  audit of every sign-in/failure/activation, disabling access revokes sessions immediately.
- **Ownership rule**: every portal query is scoped by the subscriber bound to the session. Request ids are only ever
  looked up *within* that subscriber's records; another customer's invoice, receipt, ticket or attachment returns 404
  (existence is never revealed). Customer contexts hold no staff permissions and are rejected by staff endpoints.
- Online payment from the portal returns 503 until the M-Pesa integration is enabled (phase 8); customers are shown
  how to pay with their account number instead. Payments appear only after they are confirmed server-side.
- Organization slugs that collide with portal paths (`home`, `invoices`, `payments`, `tickets`, `profile`, …) are reserved.

## Support tickets
- Numbering `TKT-000001` per organization. Channels: portal, phone, walk-in, email, internal.
- Statuses: OPEN → IN_PROGRESS (automatically on the first public staff reply) → WAITING_ON_CUSTOMER / RESOLVED
  (resolution text required) → CLOSED. A customer reply on a RESOLVED or WAITING ticket reopens it. Closed tickets
  accept no replies. Every change is a `TicketEvent`; first-response time is recorded.
- Internal notes are staff-only and never returned by customer endpoints.
- Attachments: ≤ 5 MB, PNG/JPEG/WebP/PDF/plain text, validated by file **content** (magic bytes), stored under
  server-generated keys via the storage adapter (local disk in development; S3 adapter not yet implemented), served
  with `Content-Disposition: attachment`, `nosniff` and a sandbox CSP. File names are sanitised.

## Notifications
| Template key | Category | Trigger |
| --- | --- | --- |
| `invoice.issued` | billing | Invoice issued with an amount still owing |
| `payment.received` | billing | Confirmed payment recorded or matched to a subscriber |
| `ticket.reply` | support | Public staff reply on a ticket |
| `ticket.resolved` | support | Ticket marked resolved |
| `portal.invite` | account | Staff sends a portal invite / reset |
| `subscription.expiring` | service | Reserved (reminder job planned) |

- Messages are written as `Notification` rows **inside the business transaction** (outbox) together with a durable
  `notifications.send` operation; the worker delivers them. Each message has a unique dedupe key, so retries never
  double-send.
- Preferences per subscriber, channel and category (billing/service/support). Account messages cannot be disabled.
  Opted-out messages are recorded as SKIPPED (`OPTED_OUT`).
- Templates have built-in defaults and can be customised or disabled per organization (`/notifications?tab=templates`).
- Adapters (`src/server/integrations/messaging.ts`):

| Adapter | Status | Behaviour |
| --- | --- | --- |
| Mock email / SMS (`MESSAGING_ADAPTER=mock`) | mock | Deterministic id, nothing delivered, row marked `simulated` |
| SMTP (`MESSAGING_ADAPTER=smtp` + `SMTP_*`) | not verified | nodemailer; 5xx → FAILED, transient → retried |
| Africa's Talking SMS (`SMS_PROVIDER=africastalking`, `SMS_USERNAME`, `SMS_API_KEY`, optional `SMS_SENDER_ID`) | not verified | Implemented from public docs; must be tested with real credentials before use |
| Anything unconfigured | not_configured | Message SKIPPED (`*_NOT_CONFIGURED`), never reported as sent |

Delivery receipts (DELIVERED) are not yet processed; SENT means the provider accepted the message.

## Staff notification centre
The bell shows live, permission-filtered counts: unmatched payments, overdue invoices, unassigned urgent tickets,
tickets awaiting your reply, failed notifications and dead background jobs (last 7 days). Nothing is estimated.

## Worker health endpoint
Set `WORKER_HEALTH_PORT` to expose `GET /health/live` and `GET /health/ready` (database check) on 127.0.0.1 for
container probes. The e2e suite starts the real worker this way.
