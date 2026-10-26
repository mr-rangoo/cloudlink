# Cloudlink container image (web, worker and migration targets).
# NOTE: not built on the development machine (Docker was unavailable there). The commands it runs were verified
# directly: `npm ci`, `next build`, `npm run build:worker`, the bundled worker, and a production-mode smoke test.
# Build:  docker build -t cloudlink:<version> .
#         docker build --target migrate -t cloudlink-migrate:<version> .

# ---- dependencies (including dev tools needed to build and migrate) ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `prisma generate`
RUN npm ci

# ---- build web and worker ----
FROM deps AS build
COPY . .
RUN npm run build && npm run build:worker

# ---- one-off migration job: `prisma migrate deploy` (never `migrate dev` or `reset`) ----
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- production dependencies only ----
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ---- runtime (web by default; the worker uses the same image) ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN groupadd --system --gid 1001 cloudlink && useradd --system --uid 1001 --gid cloudlink --home-dir /app cloudlink \
  && mkdir -p /app/storage && chown cloudlink:cloudlink /app/storage
COPY --from=prod-deps --chown=cloudlink:cloudlink /app/node_modules ./node_modules
COPY --from=build --chown=cloudlink:cloudlink /app/.next ./.next
COPY --from=build --chown=cloudlink:cloudlink /app/dist ./dist
COPY --from=build --chown=cloudlink:cloudlink /app/package.json /app/next.config.ts ./
USER cloudlink
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Web:    node_modules/.bin/next start -p 3000
# Worker: node --conditions=react-server dist/worker.mjs   (set WORKER_HEALTH_PORT for probes)
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
