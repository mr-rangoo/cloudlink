BEGIN;

ALTER TABLE "Router" ADD CONSTRAINT "Router_port" CHECK ("apiPort" BETWEEN 1 AND 65535);
ALTER TABLE "NetworkOperation" ADD CONSTRAINT "NetworkOperation_attempts" CHECK ("attempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 20);
CREATE TRIGGER "NetworkOperationAttempt_append_only" BEFORE UPDATE OR DELETE ON "NetworkOperationAttempt" FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();

COMMIT;
