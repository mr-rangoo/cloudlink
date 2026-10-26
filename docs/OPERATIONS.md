# Operations: backups, monitoring and incidents

## Backups
Two layers:
1. **Managed database backups** on the provider: automated daily snapshots and point-in-time recovery (PITR). On AWS RDS, set backup retention to 14 days or more and enable deletion protection.
2. **Logical backups** with `scripts/db-backup.mjs`. Before every release, and daily to separate storage:
   ```
   npm run db:backup -- --url "$DATABASE_URL" --out /var/backups/cloudlink
   ```
   This writes a compressed `pg_dump` custom-format file plus a `.sha256` checksum. Connection strings are never printed.

The database holds router and M-Pesa credentials encrypted with `APP_ENCRYPTION_KEY`. Keep that key in the secret manager, separate from the backups. A backup without the key restores everything except those credentials, which then have to be re-entered.

Also back up the attachment volume (`cloudlink_storage`, EBS snapshots). If a RADIUS database is used, back it up too; it is operator-owned.

### Restore
Restores go into a **new, empty database**. The script refuses to overwrite anything:
```
npm run db:restore -- --file backup.dump --target "postgresql://…/cloudlink_restore" --create --compare-with "$DATABASE_URL"
```
It checks the checksum, restores with `pg_restore`, confirms the Prisma migration history and, with `--compare-with`, compares every table's row count. To switch over, point `DATABASE_URL` at the restored database and restart `web` and `worker`.

### Restore test record
| Date | Source | Result |
| --- | --- | --- |
| 2026-10-26 | Local `cloudlink_e2e` (data from the e2e runs) | Restored into the new database `cloudlink_restore_check`. 70 tables and 829 rows, 0 row-count mismatches. 11 migrations present; `prisma migrate status` reported "up to date". Triggers, CHECK constraints and indexes identical (11, 42 and 201). A second restore into the now non-empty database was refused. The temporary database was then dropped. |

Repeat the test on the production provider after the first deployment, restoring into a separate instance, and add a row here.

### RPO and RTO
These are assumptions to agree with the business, not guarantees:
- **RPO:** about 5 minutes with RDS point-in-time recovery; up to 24 hours if relying on daily logical backups alone.
- **RTO:** about 1 hour to restore into a new instance and switch over. This depends on database size and has not been measured in production.

## Health and monitoring
| Signal | Where |
| --- | --- |
| Liveness | `GET /api/v1/health/live` (process up, no data) |
| Readiness | `GET /api/v1/health/ready`: configuration, database and Redis as coarse statuses. 503 when not ready. |
| Worker | `WORKER_HEALTH_PORT` → `/health/live`, `/health/ready`. Heartbeats appear on the dashboard (System status). |
| Job backlog and failures | Notification centre: "Background jobs are behind" (waiting over 10 minutes) and "Failed background jobs" |
| Payments | "Payment callbacks not processed" (failed, or waiting over 15 minutes) and "M-Pesa payments to review" (unknown outcomes) |
| Network | "Network alerts": router offline, operation failed, operation stuck. Also the dashboard Network card. |
| Messaging | "Failed notifications" |
| Logs | JSON on stdout (pino) with a correlation ID per request. Secrets and phone numbers are redacted. |

External monitoring should alert on readiness failures, a rising 5xx rate, the worker container being unhealthy, and database CPU and storage.

## Incident response
1. **Contain.** Rotate exposed secrets (below). Disable affected integrations with `PAYMENT_ADAPTER=disabled` or `NETWORK_ADAPTER=disabled` and restart. Deactivate compromised staff accounts; their sessions end at once.
2. **Investigate.** The audit log (Administration → Audit log) records sign-ins, failures, permission changes, payments, refunds, router actions, credential reveals and setup-command use, with IP addresses and correlation IDs. Match correlation IDs to application logs.
3. **Recover.** Restore from backup into a new database if data was damaged. Re-run reconciliation checks (Reconciliation page) and compare M-Pesa statements with recorded payments.
4. **Notify.** Follow the Kenya Data Protection Act (2019) obligations. Notify the Data Commissioner within 72 hours of becoming aware of a personal-data breach, and affected subscribers where required. Get legal review before production.

## Credential rotation
| Secret | How |
| --- | --- |
| `AUTH_SECRET` | Replace and restart. |
| Staff passwords | Staff → reset link; sessions are revoked. |
| Router API credentials | Router page → "Replace credentials", or generate a new setup command. |
| M-Pesa credentials | Daraja portal → regenerate → Integrations → M-Pesa settings → save. Status resets until a new payment is confirmed. |
| C2B URL token | Integrations → "Register C2B URLs" issues a new secret URL. |
| `APP_ENCRYPTION_KEY` | Not rotatable in place yet. Re-enter router and M-Pesa credentials after changing it. |
| Database password | Rotate in RDS, update `DATABASE_URL`, then restart `web` and `worker`. |
