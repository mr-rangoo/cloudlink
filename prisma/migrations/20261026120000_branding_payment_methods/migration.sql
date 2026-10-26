BEGIN;

-- CreateTable
CREATE TABLE "OrganizationBranding" (
    "organizationId" UUID NOT NULL,
    "themePreset" TEXT NOT NULL DEFAULT 'midnight',
    "customAccent" TEXT,
    "defaultMode" TEXT NOT NULL DEFAULT 'light',
    "logoKey" TEXT,
    "logoContentType" TEXT,
    "logoUpdatedAt" TIMESTAMPTZ(6),
    "portalWelcome" TEXT,
    "supportHours" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationBranding_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "CustomerPaymentMethod" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "instructions" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CustomerPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerPaymentMethod_organizationId_active_sortOrder_idx" ON "CustomerPaymentMethod"("organizationId", "active", "sortOrder");


ALTER TABLE "OrganizationBranding" ADD CONSTRAINT "OrganizationBranding_mode" CHECK ("defaultMode" IN ('light', 'dark', 'system'));
ALTER TABLE "OrganizationBranding" ADD CONSTRAINT "OrganizationBranding_accent" CHECK ("customAccent" IS NULL OR "customAccent" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "CustomerPaymentMethod" ADD CONSTRAINT "CustomerPaymentMethod_kind" CHECK ("kind" IN ('MPESA_PAYBILL', 'MPESA_TILL', 'BANK', 'CASH', 'OTHER'));

COMMIT;
