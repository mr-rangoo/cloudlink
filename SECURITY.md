# Cloudlink — Security Requirements

## Threat model
Protect subscriber personal data, financial records, payment credentials, router credentials, tenant boundaries and operational control of network equipment.

## Authentication and sessions
- Use a maintained authentication library.
- Secure, HTTP-only, SameSite cookies and Secure in production.
- Validate redirects and origins.
- Implement login throttling and safe account recovery.
- Revoke sessions when users are disabled or permissions materially change.
- Avoid storing access tokens in browser local storage where a secure server session is appropriate.

## Authorization
- Enforce authorization in server-side services and API handlers.
- Scope every tenant-owned query by organization and applicable branch.
- Check ownership on every customer-specific operation.
- Restrict exports, refunds, credits, manual adjustments and router actions.
- Test unauthorized IDs, cross-tenant access and role escalation.

## Data protection
- TLS for public and supported private connections.
- Encrypt router/provider credentials at rest or use managed secret storage.
- Separate secret access from ordinary business-data access.
- Redact secrets and unnecessary personal data from logs.
- Use data minimization, retention rules and controlled exports.
- Document Kenyan data-protection responsibilities and obtain appropriate legal/privacy review before production.

## Payments
- Never store M-Pesa PINs or card security codes.
- Validate payment amounts, references, currency and provider context.
- Verify callback authenticity using supported mechanisms.
- Deduplicate and protect against replay.
- Use transactional allocations and auditable reversals.
- Never trust client-side payment success.
- Rate-limit initiation and public callback endpoints appropriately.

## Network security
- Never expose RouterOS management ports directly to the public internet.
- Prefer VPN/private network connectivity and strict source allowlists.
- Use dedicated least-privilege router accounts.
- Allowlist supported operations; never expose arbitrary CLI execution.
- Encrypt credentials and redact them from logs.
- Apply timeouts, rate limits, and audit logs to network operations.
- Separate network operation status from billing status.

## Application security
- Validate all input.
- Prevent SQL injection through parameterized ORM queries.
- Apply output encoding and safe rendering.
- Configure CSRF protection where applicable.
- Use secure headers and an appropriate Content Security Policy.
- Validate upload size, content type and file handling.
- Avoid leaking stack traces in production.
- Keep dependencies updated and scan for vulnerabilities.
- Store secrets outside source control.

## Operations
- Back up PostgreSQL and test restoration.
- Define incident response and credential rotation.
- Monitor failed logins, webhook anomalies, repeated payment failures and router-operation errors.
- Restrict production database and Redis access.
- Use separate development, staging and production environments.
