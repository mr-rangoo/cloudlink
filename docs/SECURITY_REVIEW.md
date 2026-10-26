# Security review (release readiness, 2026-10-26)

Internal code review by the build agent against `SECURITY.md`. It is **not** an independent penetration test. Commission one before production, together with the legal and privacy review the Kenya Data Protection Act requires.

## Method
- Read every public, customer and webhook entry point. A static test (`tests/unit/route-guards.test.ts`) now fails the build if any API route is not wrapped by an authenticated handler, or is not on an explicit public allowlist, or if a staff mutation has no permission check.
- A cross-tenant sweep (`tests/integration/tenant-sweep.test.ts`) calls 25 staff detail endpoints and actions with another organization's owner session. All must return 404 and change nothing.
- Searched for raw SQL, HTML injection, redirects, cookie handling and logging of secrets.
- `npm audit` for production and development dependencies.
- Ran the app with `APP_ENV=production` and the smoke test (`scripts/smoke.mjs`), checking headers, CSP nonces, cookies, error envelopes and sign-in and sign-out.

## Findings fixed in this review
| # | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| 1 | **Open redirect after sign-in.** `/login?next=/\evil.example` passed the check (browsers treat `/\` as `//`). | `safeRedirectPath` accepts only same-origin paths, by URL parsing, without backslashes or control characters. | `tests/unit/security-headers.test.ts` |
| 2 | **No Content-Security-Policy and no HSTS.** | Per-request nonce CSP in `src/proxy.ts`: nonce plus `strict-dynamic` scripts, no framing, no plugins, form posts to self only (the captive portal may post to the hotspot router). API responses get `default-src 'none'`. HSTS in production. | Unit tests; all 22 e2e flows pass with the CSP on; production-mode smoke shows every script carries the nonce. |
| 3 | **Sign-out did not clear `__Host-` cookies in production.** The clearing cookie lacked `Secure`, so browsers ignored it. The server session was already revoked. | `clearedCookieOptions()` repeats the cookie's flags. | Smoke test: session invalid after sign-out. |
| 4 | **Captive-portal limits counted successful redemptions per IP.** Customers at one hotspot share a public address, so a busy site would be blocked. The status endpoint had no limit. | Both are failure-based: successes give their unit back, so guessing stays throttled. | `tests/integration/vouchers.test.ts` (15 valid redemptions from one IP pass; repeated failures are limited) |
| 5 | **Router session and operation lists returned 200 (empty) for another organization's router.** No data leaked, but they should not acknowledge foreign IDs. | Router filters must name a router in the caller's scope, otherwise 404. | Tenant sweep |
| 6 | **Missing monitoring signals** listed in DEPLOYMENT.md: stuck payment callbacks and job backlog. | Added to the notification centre. | Type-checked; covered by existing alert rendering |

## Findings fixed earlier (recorded in the work log)
- Per-IP login limit counted successful sign-ins, locking out shared office addresses (phase 7).
- Idempotency storage would have kept revealed PPPoE passwords and router setup links (phases 7 and 8). Such routes now declare `secretResponse`.
- M-Pesa callbacks:
  - A callback keyed only by CheckoutRequestID could be shadowed from another request's URL.
  - Failure callbacks were not verified, so a forged "cancelled" could hide a payment.

  Both fixed and tested (phase 8).

## Controls confirmed
- **Authentication.**
  - Passwords use scrypt.
  - Session tokens are random and stored hashed, in HTTP-only, SameSite=Lax, `__Host-` and Secure cookies in production.
  - Sessions are revoked on disable or on permission changes.
  - Login throttling and lockout apply, and errors are identical for unknown and known accounts (checked in production mode).
- **Authorization.** Every protected service calls `requirePermission`; tenant and branch scoping use `tenantWhere`/`listWhere`. Customer portal queries are bound to the session's subscriber. Static and integration tests above enforce this.
- **CSRF.** Origin checks on cookie-authenticated mutations, plus SameSite.
- **Input.** Zod validation on every handler. Prisma parameterised queries. The single raw `$queryRawUnsafe` takes its table name from a typed literal union and parameterises the id. No `dangerouslySetInnerHTML` anywhere.
- **Secrets.**
  - Router, M-Pesa, PPPoE and C2B tokens are encrypted with AES-256-GCM and bound to their owner.
  - Credentials are write-only through the API.
  - Logs are redacted with pino.
  - Webhook payloads are minimised, with no full phone numbers.
  - Setup scripts and revealed passwords are never cached or stored.
- **Payments.** Money is recorded only after a validated, provider-verified callback. Callbacks are deduplicated. Each M-Pesa receipt is unique across all paths in the database. No redirect-based confirmation.
- **Network.** The RouterOS API is reachable only at private or VPN addresses, enforced at save and at execution. Operations are allowlisted, with no CLI passthrough. Setup scripts restrict the API to management addresses.
- **Errors.** Stable envelope with a correlation ID; no stack traces (checked in production mode).
- **Dependencies.** `npm audit`: 0 vulnerabilities (production and development), 2026-10-26.

## Residual risks and recommendations
- **No external penetration test** and no legal or privacy review yet. Both are needed before production.
- **CSP allows inline styles** (`style-src 'unsafe-inline'`) for layout and chart attributes. Scripts remain nonce-only.
- **C2B confirmations** cannot be cryptographically verified (Daraja does not sign them). They rely on the secret URL, the shortcode check, deduplication and the optional IP allowlist. Reconcile daily against M-Pesa statements.
- **Plaintext PPPoE passwords in FreeRADIUS** (`radcheck`), as FreeRADIUS needs them for CHAP. Protect that database like a secret store.
- **Router setup over plain `fetch`.** On older RouterOS, `fetch` may not validate TLS certificates. The single use and 30-minute lifetime limit exposure.
- **`APP_ENCRYPTION_KEY` cannot be rotated in place.** Plan a re-encryption tool if rotation is required.
- **Rate limits use client IPs from X-Forwarded-For.** Deploy behind a proxy that replaces client-supplied values; the Caddy setup in `deploy/` does.

## Phase 10 additions (2026-10-26)
- **Branding uploads.** Logo files are identified by their content, so PNG, JPEG and WebP are accepted and SVG is not. The size limit is 512 KB. Logos are served with `nosniff` and `default-src 'none'`. Brand colours are limited to `#rrggbb` by a database check and are contrast-checked before being written into CSS.
- **AI assistant.**
  - The model never chooses whose data it reads: every tool takes its scope from the customer session, and tool inputs are validated with zod.
  - The only write is one support ticket per chat.
  - The API key is server-only (env), never sent to browsers, and redacted from logs. Provider errors become fixed messages.
  - Customer messages, and organization guidance, cannot change these rules. Prompt injection can at worst produce a wrong reply about the customer's own data, which the UI discloses can happen.
  - Rate limits apply per customer and per organization.
  - Production refuses `mock` and requires a key with `anthropic`. `ASSISTANT_BASE_URL` is test-only.
  - Residual risks: customer data is processed by Anthropic, so this needs the privacy review. Real-key behaviour has not been verified yet.
- **Live sessions.** Customers read only their own sessions and cannot trigger router reads. Staff live refreshes are de-duplicated every 30 seconds and need `network.read`.
