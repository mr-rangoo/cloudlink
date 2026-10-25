# Cloudlink — Integration Requirements

## Integration principles
All providers are accessed through server-side adapters. Business logic must not depend directly on a provider SDK. Store integration status and safe configuration separately from encrypted credentials or managed secret references.

Every adapter must expose:
- Configuration validation.
- Health/test operation where supported.
- Typed request and response models.
- Timeouts.
- Safe error classification.
- Structured redacted logging.
- Retry guidance.
- Idempotency behavior.
- Mock implementation for automated tests.
- Integration status: `not_configured`, `mock`, `sandbox_tested`, `production_verified`, or `error`.

## M-Pesa Daraja
Use official Safaricom Daraja documentation for the selected API version. Implement STK Push and callback handling where enabled. Validate callback structure and transaction context, amount, currency/reference as applicable. Deduplicate events durably. Never treat a browser redirect as proof of payment. Use sandbox first. Production verification requires valid approved credentials and a real approved test.

Environment variable names may include:
- `MPESA_ENVIRONMENT`
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL`

Keep secrets server-only. Never log passkeys, access tokens or sensitive callback content.

## Manual cash and bank
Support staff-recorded transactions with method, amount, currency, date, reference, staff actor, subscriber/invoice allocation and optional evidence. Apply permissions, duplicate checks and audit logging. Bank statement imports should validate and preview matches before committing.

## Additional gateways
Define a provider interface for future gateways. Do not claim a gateway is available until implemented and tested. Handle pending, confirmed, failed, cancelled, reversed and unknown states explicitly.

## MikroTik RouterOS
Use supported RouterOS API capabilities and document the tested version range. Use a private network path, VPN or secure private connectivity. Do not publish router management ports to the internet. Use least-privilege accounts, allowlists, timeouts, encrypted credentials and approved operation types.

## RADIUS
Support a configurable RADIUS adapter and accounting integration. Keep shared secrets server-side and encrypted or externally managed. Document NAS configuration, ports, firewall rules and deployment topology without assuming one universal installation.

## Email and SMS
Use provider adapters. Track queued/sent/delivered/failed status according to provider support. Apply retry limits and redact recipient details where appropriate. Do not claim delivery without acknowledgement.

## Object storage
Use an S3-compatible adapter for PDFs, exports and permitted attachments. Restrict access, validate uploads, use time-limited URLs, and apply retention policies.

## Development mocks
Mocks must be deterministic, explicit and disabled in production. Test fixtures must never represent actual money received or actual network changes. Label simulated status in the UI and logs.
