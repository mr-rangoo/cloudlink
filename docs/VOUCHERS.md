# Cloudlink — Hotspot Vouchers and Captive Portal

## Batches
- Generated from a package (usually a Hotspot package). The batch snapshots the package name, access duration,
  speeds, net price, tax rate and **face value** (net + tax), so later package edits do not change printed vouchers.
- Codes: 8–16 characters (default 10) from an unambiguous alphabet (no 0/O/1/I/L), matched case-insensitively and
  ignoring spaces/hyphens. 10 characters ≈ 8×10¹⁴ combinations.
- Storage: a keyed HMAC (HKDF of `APP_ENCRYPTION_KEY`, scoped by organization) for lookup and an AES-256-GCM encrypted
  copy for controlled exports. Plaintext codes are returned **once** at generation and otherwise only through the
  audited export (`vouchers.export`): printable PDF cards or CSV of the *unused* codes. Export counts are shown on the
  batch. Rotating `APP_ENCRYPTION_KEY` requires re-hashing voucher codes (decrypt with the old key, re-hash).
- A batch can be voided (unused vouchers stop working; redeemed ones are unaffected) and can carry a "redeem by" date.

## Redemption
- Channels: captive portal (`/hotspot/<provider-code>`, public) and staff-assisted (`/vouchers?tab=redeem`).
- Atomic and concurrency-safe: the voucher row is locked (`SELECT … FOR UPDATE`) and `VoucherRedemption.voucherId` is
  unique, so exactly one of many simultaneous attempts succeeds (tested with 8 concurrent attempts).
- Access period: package duration from the moment of redemption (organization timezone).
- Expired vouchers are marked EXPIRED on first attempt; void or unknown codes get a generic "not valid" message.
- Captive portal protections: same-origin POST, 10 attempts per IP per 10 minutes, 600 per organization per minute,
  status polling requires the voucher code (sent in a POST body, never in the URL).

## Accounting
| Event | Ledger |
| --- | --- |
| Voucher redeemed | Dr Voucher receivable 1150 (face value) / Cr Revenue 4000 (net) / Cr Tax payable 2200 |
| Agent commission (on redemption of an agent's voucher) | Dr Agent commissions 5100 / Cr Voucher receivable 1150 |
| Agent remittance | Dr Cash/Bank/M-Pesa / Cr Voucher receivable 1150 |

Agent balance (owed) = face value of redeemed vouchers − commissions − remittances; remittances cannot exceed it.
Direct (office) sales use the same receivable. The reconciliation checks verify that ledger account 1150 equals the
total owed according to the records. Redemptions, commissions and remittances are append-only.

## Network activation
The redemption transaction also creates a durable `hotspot.user.upsert` network operation (see `docs/NETWORK.md`).
It provisions a hotspot user on the batch's router: username and password are the code, the profile is the package's
router profile, the uptime limit is the remaining access time, and the MAC binding is optional. If the batch names
no router, Cloudlink uses the organization's only hotspot-enabled router.

| `NETWORK_ADAPTER` | Result recorded on the redemption |
| --- | --- |
| `mock` (development) | `SIMULATED`, "No router was changed". The portal says "test mode". |
| `routeros` | `ACTIVE` after the router accepts the user and the read-back matches. Retried on timeouts. `FAILED` with the reason after a permanent error, exhausted retries, or when no hotspot router is assigned. |
| `disabled` | `FAILED`, "network automation is disabled". |

Failed activations raise a network alert. Staff can retry them from the operation page.

The captive portal only submits credentials to the router's own login URL (`link-login-only`, accepted only for
private-network addresses) when the status is `ACTIVE`. Billing (the redemption) and network status are separate.

## MikroTik hotspot setup
Configure the hotspot login page to redirect to
`https://<cloudlink-host>/hotspot/<provider-code>?mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only)&dst=$(link-orig)`
and add the Cloudlink host to the hotspot walled garden.
