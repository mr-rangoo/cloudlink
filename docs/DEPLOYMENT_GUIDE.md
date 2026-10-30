# Deployment guide

**Status: documented, not executed.** No cloud account or deployment authorization was given, and Docker was not available on the build machine. The container artefacts below were therefore never built. What has been verified:
- the production build;
- the bundled worker;
- a production-mode run (`APP_ENV=production`, all mock adapters off), which passed every smoke check (`scripts/smoke.mjs`);
- a backup restored into a separate database (see `docs/OPERATIONS.md`).

## Recommended shape: AWS Africa (Cape Town, `af-south-1`)
Cloudlink needs a long-running worker and a private path to MikroTik routers, so a web-only serverless host is not enough. A small, conventional setup:

| Component | Service | Notes |
| --- | --- | --- |
| Web + worker | 1× EC2 VM (Ubuntu 24.04, 2 vCPU / 4 GB to start) running `deploy/compose.production.yaml` | Caddy terminates TLS with automatic certificates. The worker uses host networking so it can reach routers over WireGuard. |
| PostgreSQL 16+ | Amazon RDS for PostgreSQL, private subnet, Multi-AZ for production | Automated backups (7–35 days) and point-in-time recovery. Enforce SSL (`?sslmode=require` in `DATABASE_URL`). |
| Redis | Amazon ElastiCache for Redis/Valkey, private | Optional but recommended (immediate job dispatch). The worker falls back to database polling if Redis is down. |
| Secrets | AWS Secrets Manager or SSM Parameter Store | Render `.env.production` on the VM at deploy time. Never commit it. |
| Router access | WireGuard on the VM (for example `10.8.0.1/24`) with a peer on each MikroTik | Put the VPN subnet in `MIKROTIK_ALLOWED_NETWORKS` and the VM's tunnel address in `ROUTER_MANAGEMENT_SOURCES`. |
| Files | EBS volume (`cloudlink_storage`) | Ticket attachments. The S3 adapter is not implemented yet. Back up the volume with snapshots. |
| Monitoring | CloudWatch agent (logs and metrics) plus an uptime check on `/api/v1/health/ready` | Add alerts on 5xx rates, readiness, and the worker container health. |

Security groups:
- **Internet → VM:** 80 and 443 only, plus the WireGuard UDP port from your routers' public addresses.
- **VM → RDS:** 5432 only. **VM → ElastiCache:** 6379 only.
- **SSH:** no public SSH; use SSM Session Manager.
- **RouterOS API:** never opened to the internet. It is reachable only inside the WireGuard tunnel.

Any provider with long-running VMs, managed PostgreSQL and private networking can host the same compose stack. Examples are DigitalOcean (Droplet, Managed PostgreSQL and Valkey) or a local Kenyan data centre. Only the table above changes.

## Production environment
Start from `.env.example`. Production requires:

| Setting | Value |
| --- | --- |
| `APP_ENV` | `production` |
| `APP_URL` | `https://<your domain>` |
| `AUTH_SECRET` | 32+ random bytes (`openssl rand -base64 48`) |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). **Back it up in the secret manager.** Losing it makes stored router and M-Pesa credentials unreadable. |
| `DATABASE_URL`, `REDIS_URL` | Private endpoints, TLS where supported |
| `PAYMENT_ADAPTER` | `daraja` or `disabled` (never `mock`) |
| `NETWORK_ADAPTER` | `routeros` or `disabled` (never `mock`). With `routeros`, `MIKROTIK_ALLOWED_NETWORKS` is mandatory. |
| `MIKROTIK_CONNECTION_MODE` | `api-ssl` recommended |
| `MESSAGING_ADAPTER` | `live` (each organization's own SMS/email providers, else `SMS_*` / `SMTP_*`) or `disabled` |
| `ASSISTANT_ADAPTER` | `anthropic` (with `ANTHROPIC_API_KEY`) or `disabled` (default). `mock` is refused. See `docs/ASSISTANT.md` |
| `ANTHROPIC_API_KEY` | Claude API key for the portal assistant, kept in the secret store |
| `ASSISTANT_MODEL` / `ASSISTANT_EFFORT` | Optional; defaults `claude-opus-5-5` / `low` |
| `ENABLE_DEMO_SEED` | `false` |
| `MPESA_VERIFY_CALLBACKS` | `true` (enforced) |
| `MPESA_BASE_URL`, `OPERATION_BACKOFF_BASE_MS` | Empty (test-only) |

The app refuses to start serving as "ready" with an invalid production configuration, and env validation lists what is wrong.

## First deployment
1. Build and push the images from a CI runner:
   ```
   docker build -t <registry>/cloudlink:<version> .
   docker build --target migrate -t <registry>/cloudlink-migrate:<version> .
   ```
2. On the VM, write `.env.production` from the secret manager. Set `CLOUDLINK_IMAGE`, `CLOUDLINK_MIGRATE_IMAGE` and `CLOUDLINK_DOMAIN`.
3. Point DNS at the VM.
4. Apply migrations as a separate, controlled step:
   ```
   docker compose -f deploy/compose.production.yaml --env-file .env.production --profile release run --rm migrate
   ```
5. Start the services:
   ```
   docker compose -f deploy/compose.production.yaml --env-file .env.production up -d web worker caddy
   ```
6. Create the first organization and owner. Use a one-off admin task with `createOrganizationWithOwner`; do not use the demo seed.
7. Run the smoke test:
   ```
   SMOKE_EMAIL=<owner> SMOKE_PASSWORD=<…> node scripts/smoke.mjs --base https://<domain> --worker http://127.0.0.1:3199
   ```
8. Configure M-Pesa under Integrations. Register routers, preferably with the setup command. Confirm the Integrations page shows real statuses.

## Release procedure (every update)
1. CI: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:integration`, `npm run build`, `npm run test:e2e`.
2. Review new migrations in `prisma/migrations`. They are wrapped in transactions and never drop data without an explicit plan.
3. Back up first: `npm run db:backup -- --url "$DATABASE_URL" --out /var/backups/cloudlink`, plus an RDS snapshot.
4. Run the `migrate` job.
5. Deploy `web` and `worker` with the same version. Older workers stop gracefully on SIGTERM.
6. Run `scripts/smoke.mjs`, then check logs, the Integrations page, the notification centre (job backlog, network and payment alerts) and the dashboard.
7. Roll back if needed:
   - **Code:** redeploy the previous image tag. Migrations are additive, so the previous version keeps working.
   - **Schema:** if a migration must be reverted, restore the pre-release backup into a new database and switch `DATABASE_URL` (see `docs/OPERATIONS.md`). Never run `prisma migrate reset` on production.

## Production readiness checklist
| Item | Status |
| --- | --- |
| Secrets managed outside source control | Ready (`.env*` git-ignored, guidance above) |
| TLS and domain | To do at deployment (Caddy automatic HTTPS) |
| Database and Redis private | To do at deployment (security groups above) |
| Migrations reviewed and applied | Migrations reviewed; apply with the `migrate` job |
| Backup and restore tested | Done locally (restore into a separate database, row counts and schema objects identical); repeat on RDS |
| Worker deployed and monitored | Health endpoint and compose health check ready; deploy pending |
| Mock adapters disabled | Enforced by env validation in production |
| M-Pesa production credentials and callback verified | **Pending credentials** (sandbox first) |
| Router private connectivity tested | **Pending hardware/VPN** |
| Health checks and alerts active | Endpoints and in-app alerts ready; wire the uptime check at deployment |
| Smoke tests passed | Passed in a local production-mode run; repeat after deployment |
| Rollback procedure documented | Yes (above) |
