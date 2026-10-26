# Cloudlink — Local Development Setup

## Prerequisites
- Node.js 22+ (tested with 24.14) and npm.
- PostgreSQL 16+ (tested with 18.3).
- Redis 7+ (optional in development; tested with 8.10). Without Redis the worker uses PostgreSQL polling.

## Option A — Docker Compose (recommended when Docker is available)
```bash
docker compose up -d          # PostgreSQL on 127.0.0.1:5432, Redis on 127.0.0.1:6379
cp .env.example .env          # then set AUTH_SECRET and APP_ENCRYPTION_KEY
```
Create the test databases once:
```bash
docker exec -it cloudlink-postgres psql -U cloudlink -c "create database cloudlink_test" -c "create database cloudlink_e2e"
```

## Option B — Project-local PostgreSQL cluster (no Docker)
If PostgreSQL binaries are installed (e.g. `C:\Program Files\PostgreSQL\18\bin`), create a private cluster inside
`.local/` so no existing server is touched:
```bash
initdb -D .local/pgdata -U cloudlink --pwfile=<file-with-password> --auth=scram-sha-256 -E UTF8 --locale=C
npm run db:local:start        # listens on 127.0.0.1:5433 only
psql -h 127.0.0.1 -p 5433 -U cloudlink -d postgres -c "create database cloudlink" -c "create database cloudlink_test" -c "create database cloudlink_e2e"
```
Point `DATABASE_URL`, `TEST_DATABASE_URL` and `E2E_DATABASE_URL` at port 5433. Stop with `npm run db:local:stop`.
Set `PG_BIN` if your PostgreSQL bin directory is elsewhere.

Redis without Docker on Windows: a portable community build (e.g. redis-windows 8.x) can be run bound to
`127.0.0.1` for development only. Production must use managed Redis.

## Install, migrate, seed
```bash
npm install                   # also runs prisma generate
npm run db:migrate            # applies migrations to DATABASE_URL (development)
SEED_PASSWORD='choose-a-dev-password' npm run db:seed   # fictional demo organizations and staff
```
The seed refuses to run when `APP_ENV=production` or `ENABLE_DEMO_SEED` is not `true`.

## Run
```bash
npm run dev                   # web on http://localhost:3100
npm run worker                # background worker (separate process)
```

## Verify
```bash
npm run lint
npm run typecheck
npm run test                  # unit
npm run test:integration      # needs TEST_DATABASE_URL (name must end in _test); Redis test runs if TEST_REDIS_URL is reachable
npm run build
npm run test:e2e              # needs a production build and E2E_DATABASE_URL (name must end in _e2e); npx playwright install chromium once
npm run build:worker          # bundles the worker to dist/worker.mjs (production: npm run start:worker)
npm run smoke -- --base http://127.0.0.1:3100   # release smoke test against a running app
```

## Notes
- Database sessions are pinned to UTC by the application. Business-calendar logic converts to the organization timezone.
- Never point test URLs at a real database; the harness refuses database names that do not end in `_test`/`_e2e`.
- The `.local/` directory (cluster data, logs, portable binaries) is git-ignored.
- Network: development uses `NETWORK_ADAPTER=mock` (nothing is contacted). Name a router with `[flaky]`, `[offline]` or
  `[reject]` to see retries and alerts. The integration tests start a fake RouterOS API server on 127.0.0.1 and install
  the FreeRADIUS-compatible tables from `deploy/radius/schema.sql` into a `radius` schema of the test database; no device
  or RADIUS server is needed. See `docs/NETWORK.md` for real routers.
