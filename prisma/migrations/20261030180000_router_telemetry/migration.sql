-- Router telemetry: health samples (charts, health score, reachability), read-only snapshots (logs, diagnosis),
-- maintenance mode and the charted uplink interface. Additive only.
BEGIN;

-- AlterTable
ALTER TABLE "Router" ADD COLUMN     "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maintenanceNote" TEXT,
ADD COLUMN     "uplinkInterface" TEXT;

-- CreateTable
CREATE TABLE "RouterMetricSample" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routerId" UUID NOT NULL,
    "takenAt" TIMESTAMPTZ(6) NOT NULL,
    "reachable" BOOLEAN NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "responseMs" INTEGER,
    "cpuLoad" INTEGER,
    "memoryUsedPct" INTEGER,
    "diskUsedPct" INTEGER,
    "temperatureC" DECIMAL(5,1),
    "uptimeSeconds" INTEGER,
    "rxBps" BIGINT,
    "txBps" BIGINT,
    "sessions" INTEGER,

    CONSTRAINT "RouterMetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouterSnapshot" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "operationId" UUID,
    "takenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouterSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RouterMetricSample_routerId_takenAt_idx" ON "RouterMetricSample"("routerId", "takenAt");

-- CreateIndex
CREATE INDEX "RouterMetricSample_organizationId_takenAt_idx" ON "RouterMetricSample"("organizationId", "takenAt");

-- CreateIndex
CREATE INDEX "RouterSnapshot_routerId_kind_takenAt_idx" ON "RouterSnapshot"("routerId", "kind", "takenAt");

-- AddForeignKey
ALTER TABLE "RouterMetricSample" ADD CONSTRAINT "RouterMetricSample_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouterSnapshot" ADD CONSTRAINT "RouterSnapshot_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "Router"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "RouterMetricSample" ADD CONSTRAINT "RouterMetricSample_ranges" CHECK (
  ("cpuLoad" IS NULL OR "cpuLoad" BETWEEN 0 AND 100) AND ("memoryUsedPct" IS NULL OR "memoryUsedPct" BETWEEN 0 AND 100)
  AND ("diskUsedPct" IS NULL OR "diskUsedPct" BETWEEN 0 AND 100) AND ("responseMs" IS NULL OR "responseMs" >= 0)
  AND ("uptimeSeconds" IS NULL OR "uptimeSeconds" >= 0) AND ("rxBps" IS NULL OR "rxBps" >= 0) AND ("txBps" IS NULL OR "txBps" >= 0)
  AND ("sessions" IS NULL OR "sessions" >= 0));
ALTER TABLE "RouterSnapshot" ADD CONSTRAINT "RouterSnapshot_kind" CHECK ("kind" IN ('logs', 'diagnosis'));
ALTER TABLE "Router" ADD CONSTRAINT "Router_uplink_interface" CHECK ("uplinkInterface" IS NULL OR "uplinkInterface" ~ '^[A-Za-z0-9._<>/-]{1,64}$');

COMMIT;
