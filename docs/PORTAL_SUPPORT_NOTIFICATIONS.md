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
| `subscriber.welcome` | account | Staff create a subscriber or convert a lead (not CSV imports or captive-portal buyers) |
| `invoice.issued` | billing | Invoice issued with an amount still owing |
| `payment.received` | billing | Confirmed payment recorded or matched to a subscriber (captive-portal purchases get `hotspot.purchased` instead) |
| `credit.saved` | billing | Part of a confirmed payment was not needed by any invoice and stays as credit |
| `subscription.expiring` | service | Hourly job: a plan of a week or longer ends within the organization's reminder window (Settings → Billing, default 3 days, 0 = off); once per period |
| `subscription.expired` | service | A plan of a week or longer expired (short hotspot plans do not text the customer each time) |
| `hotspot.purchased` | service | A captive-portal purchase was applied: plan, end time and the M-Pesa code for “Already paid” |
| `voucher.delivery` | account | Staff send an unused voucher by SMS (needs `vouchers.export`; audited) |
| `ticket.reply` | support | Public staff reply on a ticket |
| `ticket.resolved` | support | Ticket marked resolved |
| `portal.invite` | account | Staff sends a portal invite / reset |

- Messages are written as `Notification` rows **inside the business transaction** (outbox) together with a durable
  `notifications.send` operation; the worker delivers them. Each message has a unique dedupe key, so retries never
  double-send.
- Preferences per subscriber, channel and category (billing/service/support). Account messages cannot be disabled.
  Opted-out messages are recorded as SKIPPED (`OPTED_OUT`).
- Templates have built-in defaults and can be customised or disabled per organization (`/notifications?tab=templates`).
  The portal invite must contain `{{link}}` and the voucher message `{{code}}`. Both are filled in by the worker at
  send time and are never stored in the message log (it keeps a placeholder). A voucher redeemed or voided before its
  message goes out makes the message FAILED (`VOUCHER_UNAVAILABLE`).

### Providers
Each organization connects its own accounts on **Integrations → Messaging providers** (`integrations.write`):
- **SMS**: Africa's Talking (username, optional sender ID, API key) or Twilio (account SID, sender: number, messaging
  service SID or sender ID, auth token). **Email**: an SMTP server (host, port, SSL/STARTTLS, optional login, from
  address and name).
- Credentials are AES-256-GCM encrypted (bound to the organization and channel), write-only, never logged.
- **Send test** sends one message now and records whether the provider *accepted* it. A provider becomes verified only
  when a staff member then confirms the message arrived (`SANDBOX_TESTED` for the Africa's Talking sandbox,
  otherwise `PRODUCTION_VERIFIED`). Changing the provider, credentials, sender or server resets verification.
- **SMS balance**: Africa's Talking and Twilio report the prepaid balance on request.
- In production an SMTP host must resolve only to public addresses, use port 25, 465, 587 or 2525, and use SSL or
  STARTTLS, so a tenant cannot point the worker at internal services.

Which adapter delivers a message (`src/server/services/messaging-config.ts`, `src/server/integrations/messaging.ts`):

| `MESSAGING_ADAPTER` | Behaviour |
| --- | --- |
| `mock` (development default; refused in production) | Deterministic id, nothing delivered, row marked `simulated` |
| `live` (or the older `smtp`) | The organization's saved provider; else the deployment's `SMS_*` / `SMTP_*` environment settings; else SKIPPED (`*_NOT_CONFIGURED`) |
| `disabled` | Every message SKIPPED |

Environment fallback for single-tenant deployments: `SMS_PROVIDER=africastalking` (`SMS_USERNAME`, `SMS_API_KEY`, optional
`SMS_SENDER_ID`) or `SMS_PROVIDER=twilio` (`SMS_USERNAME` = account SID, `SMS_API_KEY` = auth token, `SMS_SENDER_ID` =
sender), and `SMTP_*`.

All three providers are implemented from public documentation and tested against local fakes only; **none has been
verified with a real account**. Delivery receipts (DELIVERED) are not yet processed; SENT means the provider accepted
the message. WhatsApp is not implemented: business messages need a verified Meta business account and approved
message templates.

## Staff notification centre
The bell shows live, permission-filtered counts: unmatched payments, overdue invoices, unassigned urgent tickets,
tickets awaiting your reply, failed notifications and dead background jobs (last 7 days). Nothing is estimated.

## Worker health endpoint
Set `WORKER_HEALTH_PORT` to expose `GET /health/live` and `GET /health/ready` (database check) on 127.0.0.1 for
container probes. The e2e suite starts the real worker this way.
