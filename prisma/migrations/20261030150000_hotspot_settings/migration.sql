-- Captive portal settings: template, headline, how-to-buy steps, support contacts, visible tabs.
BEGIN;

CREATE TABLE "HotspotSettings" (
    "organizationId" UUID NOT NULL,
    "template" TEXT NOT NULL DEFAULT 'harbor',
    "headline" TEXT,
    "instructions" TEXT,
    "supportPhone" TEXT,
    "whatsappPhone" TEXT,
    "showVouchers" BOOLEAN NOT NULL DEFAULT true,
    "showReconnect" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "HotspotSettings_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "HotspotSettings_template" CHECK ("template" ~ '^[a-z]{2,20}$'),
    CONSTRAINT "HotspotSettings_phones" CHECK (("supportPhone" IS NULL OR "supportPhone" ~ '^[1-9][0-9]{7,14}$') AND ("whatsappPhone" IS NULL OR "whatsappPhone" ~ '^[1-9][0-9]{7,14}$')),
    CONSTRAINT "HotspotSettings_lengths" CHECK (char_length(coalesce("headline", '')) <= 160 AND char_length(coalesce("instructions", '')) <= 1500)
);

COMMIT;
