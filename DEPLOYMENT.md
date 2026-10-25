# Cloudlink — Cloud Deployment and Operations

## Deployment shape
Deploy:
1. Next.js web service.
2. Dedicated background worker.
3. Managed PostgreSQL.
4. Managed Redis.
5. S3-compatible object storage if required.
6. Secret manager.
7. Monitoring/logging.
8. Private VPN/network path to MikroTik devices where network automation is enabled.

Choose one concrete provider based on supported long-running workers, managed PostgreSQL/Redis, secret storage, and private connectivity. Document provider-specific settings separately. A web-only serverless service is not sufficient by itself for reliable persistent worker execution.

## Environment separation
Use distinct development, staging and production credentials and infrastructure. Never reuse production secrets in local development. Mock payment and network adapters must be disabled in production.

## Release procedure
1. Run lint, typecheck, unit/integration tests and production build.
2. Review migration plan.
3. Back up production database before risky migrations.
4. Apply migrations as a controlled release step.
5. Deploy web and worker compatible with the schema.
6. Run health/readiness checks and smoke tests.
7. Inspect logs and queue health.
8. Confirm payment and network integration status.
9. Keep a documented rollback plan.

## Health and monitoring
Provide:
- Liveness endpoint.
- Readiness endpoint checking required dependencies safely.
- Worker heartbeat/health.
- Queue backlog and failed-job monitoring.
- Database connection health.
- Integration status.
- Alerts for stuck payment events, repeated webhook errors, failed network operations and job backlogs.

Do not expose sensitive health information publicly.

## Backups and recovery
- Configure automated database backups and retention.
- Document point-in-time recovery where supported.
- Back up necessary application configuration without exposing secrets.
- Test restoration into a separate environment.
- Document RPO/RTO assumptions rather than inventing guarantees.

## Router connectivity
Keep management connectivity private through VPN/private networking and allowlists. Do not open RouterOS management ports to the public internet. If cloud-to-router connectivity is not ready, keep the adapter in mock/unconfigured mode and clearly show that status.

## Production readiness checklist
- [ ] Secrets managed outside source control.
- [ ] TLS and domain configured.
- [ ] Database and Redis private.
- [ ] Migrations reviewed and applied.
- [ ] Backup and restore procedure tested.
- [ ] Worker is deployed and monitored.
- [ ] Mock adapters disabled.
- [ ] M-Pesa production credentials and callback verified if enabled.
- [ ] Router private connectivity tested if enabled.
- [ ] Health checks and alerts active.
- [ ] Smoke tests passed.
- [ ] Rollback procedure documented.
