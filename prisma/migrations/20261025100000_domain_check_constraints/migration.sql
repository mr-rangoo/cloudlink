-- Defence-in-depth CHECK constraints for catalogue and subscription invariants.
-- Application validation enforces the same rules; these stop bad data from any other path.
ALTER TABLE "Package" ADD CONSTRAINT "Package_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "Package" ADD CONSTRAINT "Package_taxRate_range" CHECK ("taxRate" >= 0 AND "taxRate" <= 100);
ALTER TABLE "Package" ADD CONSTRAINT "Package_billingCount_positive" CHECK ("billingCount" >= 1);
ALTER TABLE "Package" ADD CONSTRAINT "Package_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_taxRate_range" CHECK ("taxRate" >= 0 AND "taxRate" <= 100);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_billingCount_positive" CHECK ("billingCount" >= 1);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_graceDays_nonnegative" CHECK ("graceDays" >= 0);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_periodIndex_nonnegative" CHECK ("periodIndex" >= 0);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_period_order" CHECK ("currentPeriodEnd" IS NULL OR "currentPeriodStart" IS NULL OR "currentPeriodEnd" > "currentPeriodStart");
ALTER TABLE "OrganizationCounter" ADD CONSTRAINT "OrganizationCounter_value_nonnegative" CHECK ("value" >= 0);
