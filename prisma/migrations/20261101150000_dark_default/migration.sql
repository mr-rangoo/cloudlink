BEGIN;

-- Dark is the default appearance for organizations that have not chosen one.
ALTER TABLE "OrganizationBranding" ALTER COLUMN "defaultMode" SET DEFAULT 'dark';
ALTER TABLE "OrganizationBranding" ALTER COLUMN "themePreset" SET DEFAULT 'violet';

COMMIT;
