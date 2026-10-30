BEGIN;
-- CreateTable
CREATE TABLE "PaymentGatewaySettings" (
    "organizationId" UUID NOT NULL,
    "activeProvider" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PaymentGatewaySettings_pkey" PRIMARY KEY ("organizationId")
);


ALTER TABLE "PaymentGatewaySettings" ADD CONSTRAINT "PaymentGatewaySettings_provider" CHECK ("activeProvider" IN ('mpesa_daraja', 'kopokopo'));

COMMIT;
