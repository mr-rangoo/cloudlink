# Payments: M-Pesa (Daraja), manual receipts and gateways

Cloudlink records money only when it is confirmed. A browser redirect, a page the customer sees, or a provider
callback on its own never counts as payment.

## Verification status
| Area | Status |
| --- | --- |
| Daraja adapter (OAuth, STK Push, STK Push Query, C2B URL registration) | Implemented from the public Daraja documentation. Tested against an in-process fake Daraja server that enforces the documented rules (`tests/support/fake-daraja.ts`). The STK password matches the documented example. |
| Callback handling (STK and C2B) | Tested end to end through the real route handlers: validation, deduplication, verification, allocation, renewals and ledger. |
| Safaricom sandbox | **Not verified.** No sandbox credentials have been supplied. |
| Production | **Not verified.** Requires approved credentials and a real payment. |

The Integrations page reports "Sandbox tested" or "Production verified" only after a real payment is confirmed in that environment. Saving or testing credentials is not enough.

## Adapters (`PAYMENT_ADAPTER`)
| Mode | Behaviour |
| --- | --- |
| `mock` | Development and tests. No prompt is sent and no money moves. A request stays "waiting" until staff simulate the customer's response, outside production only. The simulation goes through the same callback pipeline. Simulated payments use provider `mock`, receipts start with `SIM`, and the UI labels them. Rejected when `APP_ENV=production`. |
| `daraja` | Real Daraja. Each organization uses the credentials saved under Integrations, or the `MPESA_*` variables for the organization named in `MPESA_ENV_ORGANIZATION`. |
| `disabled` | Online payment is unavailable. Customers are told to pay by account number. |

## STK Push (Lipa Na M-Pesa Online)
Staff use "Request M-Pesa" on a subscriber's billing card. Customers use "Pay with M-Pesa" in the portal, on their account or on a specific invoice.

1. Cloudlink validates the request. The phone must be a Kenyan mobile number. The amount must be whole shillings from 1 to 250,000, and no more than the invoice balance when paying an invoice. Rate limits apply per phone and per subscriber.
2. A `PaymentAttempt` is stored. It is idempotent per Idempotency-Key (staff) or per form request id (portal). Its callback URL carries a fresh secret token, and only the token's SHA-256 hash is stored.
3. Daraja is called with a password of `base64(shortcode + passkey + timestamp)` and an East Africa Time timestamp. Paybills use `CustomerPayBillOnline`; tills use `CustomerBuyGoodsOnline` with the till number as PartyB.
4. Each outcome is handled as follows:
   - **Accepted.** The request is `SUBMITTED`, and a status query is scheduled.
   - **Rejected (4xx).** The request is `FAILED` with M-Pesa's reason. It never reached the phone.
   - **Timeout or unreachable.** The request is `UNKNOWN`. A prompt may have been sent, so nothing is guessed. A callback on the request's URL can still confirm it.

### When the callback arrives
Money is recorded only when all of these hold:

1. The callback arrived on the request's secret URL, from an allowed source if `MPESA_CALLBACK_ALLOWED_IPS` is set.
2. The body is well formed, and its CheckoutRequestID and MerchantRequestID match the request.
3. On success, it carries a receipt number and exactly the requested amount.
4. An STK Push Query to Daraja confirms the same outcome. This applies to failures too, so a forged "cancelled" cannot hide a real payment.

Every callback is stored once in `WebhookEvent` before processing, keyed by request plus CheckoutRequestID. The stored payload has no full phone numbers.

- **Identical repeats** are acknowledged and counted, never applied again.
- **Repeats with a different body** are flagged and stored separately, then judged on their own merits.
- **Verification that cannot finish yet** returns M-Pesa an acknowledgement and is retried by the worker (`payments.mpesa.verify`).

On confirmation, one transaction does all of the following:

- Creates the payment with method M-Pesa, the M-Pesa receipt and a gapless Cloudlink receipt number.
- Posts the ledger entry: debit 1020 M-Pesa, credit customer credit.
- Allocates to the chosen invoice, then oldest-first.
- Renews a lapsed subscription. Its network enable is queued in the same transaction (see `docs/NETWORK.md`).
- Queues the "payment received" message and marks the request `CONFIRMED`.

A partial unique index allows each M-Pesa receipt to back only one live payment per organization, whichever path recorded it: STK, C2B or manual entry.

### No callback
`payments.mpesa.query` asks Daraja for the outcome about 45 seconds after the request, then with growing gaps (up to 6 checks over roughly 15 minutes). Staff can also click "Check with M-Pesa".

- **Cancelled, failed or expired.** The request is set to that outcome, with a plain-language reason.
- **Still processing after the last check.** The request is set to `UNKNOWN`.
- **Success, but no callback.** No money is recorded from a query alone, because there is no receipt number. The request becomes `UNKNOWN`, appears as "M-Pesa payments to review" in the notification centre, and is matched from the M-Pesa statement. If the callback arrives later, it is still verified and recorded.

A subscription is not expired while its subscriber has a payment request in progress (30 minutes) or an unresolved `UNKNOWN` request (24 hours).

## C2B: payments made directly to the paybill or till
1. Under Integrations, "Register C2B URLs" calls Daraja's Register URL API. The URLs contain a new secret token per organization, stored encrypted with only its hash used for lookup. They avoid the words "mpesa" and "safaricom", which Daraja refuses.
2. Confirmations are deduplicated by TransID. The shortcode must match the organization's.
3. The payer is matched in this order:
   - the account reference typed (subscriber account number, case and spaces ignored);
   - an invoice number;
   - an unmasked phone number belonging to exactly one subscriber.

   Matched payments are allocated and can renew service. Unmatched payments are recorded as unidentified receipts and appear under Reconciliation.
4. Validation requests are accepted by default. "Reject unknown account references" makes Cloudlink answer `C2B00012` for references it cannot match. This only works when Safaricom has enabled external validation for the shortcode.

Daraja does not sign C2B confirmations. The protections are the secret URL, the shortcode check, deduplication, the optional source allowlist, and daily reconciliation against the M-Pesa statement.

## Manual receipts
Cash, bank, cheque and manual M-Pesa entries are recorded by staff with `payments.record`. A reference (bank or M-Pesa receipt) can back only one live payment. Entering an M-Pesa receipt that a callback already recorded is refused with "already recorded".

## Configuration
1. Create a Daraja app at developer.safaricom.co.ke. For production, go live with your paybill or till and get the production passkey.
2. Set `PAYMENT_ADAPTER=daraja`. Make sure `APP_URL`, or `MPESA_CALLBACK_URL`, is the public HTTPS address Safaricom can reach.
3. Under Integrations → M-Pesa settings, enter:
   - the environment;
   - paybill or till;
   - the shortcode (the store number for tills);
   - the till number, for tills;
   - the consumer key, consumer secret and passkey.

   They are stored encrypted (AES-256-GCM, bound to the organization) and are never shown again.
4. Click "Test credentials". This fetches an OAuth token only; no money moves.
5. Optionally click "Register C2B URLs".
6. In the sandbox, request a small payment from a test phone, complete it, and confirm the request shows "Paid" with an M-Pesa receipt. The Integrations page then shows "Sandbox tested". Record the result in `IMPLEMENTATION_PLAN.md`.

| Variable | Purpose |
| --- | --- |
| `PAYMENT_ADAPTER` | `mock`, `daraja` or `disabled`. |
| `MPESA_ENVIRONMENT`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_SHORTCODE_TYPE`, `MPESA_TILL_NUMBER` | Single-tenant alternative to saved settings. |
| `MPESA_ENV_ORGANIZATION` | Slug of the organization that may use the variables above. |
| `MPESA_CALLBACK_URL` | Public HTTPS base for callbacks (defaults to `APP_URL`). |
| `MPESA_CALLBACK_ALLOWED_IPS` | Optional source allowlist for webhooks. Your proxy must set X-Forwarded-For correctly. |
| `MPESA_VERIFY_CALLBACKS` | Default `true`. Cannot be `false` in production. |
| `MPESA_BASE_URL` | Test-only fake-server override. Must be empty in production. |

## Adding another gateway
Implement `PaymentGateway` (`src/server/integrations/payments/gateway.ts`): `requestPayment`, `queryPayment`, `testCredentials` and `registerC2bUrls` where supported.

- Add the gateway to `resolveGateway()`, with a fake server for tests.
- Map the provider's states to pending, confirmed, failed, cancelled, expired and unknown.
- Feed its callbacks through the same store, verify and confirm path.
- Do not show the gateway as available until its sandbox flow has been tested.

## Not implemented
- Refunds back to M-Pesa (B2C) and M-Pesa reversals. Refunds are recorded manually.
- Daraja Transaction Status API for C2B verification, which needs initiator credentials.
- Buying hotspot vouchers online from the captive portal. Vouchers are sold by staff and agents.
- Card and other gateways.
