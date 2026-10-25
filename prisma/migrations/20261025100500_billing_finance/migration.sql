-- Wrapped in a transaction so a failure leaves no partial schema.
BEGIN;

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MPESA', 'CHEQUE', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REVERSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "invoicedThrough" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "BillingSettings" (
    "organizationId" UUID NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "receiptPrefix" TEXT NOT NULL DEFAULT 'RCT',
    "creditNotePrefix" TEXT NOT NULL DEFAULT 'CRN',
    "invoiceLeadDays" INTEGER NOT NULL DEFAULT 3,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 0,
    "invoiceOnActivation" BOOLEAN NOT NULL DEFAULT true,
    "taxLabel" TEXT NOT NULL DEFAULT 'VAT',
    "taxPin" TEXT,
    "legalName" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "invoiceFooter" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BillingSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "subscriberId" UUID NOT NULL,
    "subscriptionId" UUID,
    "invoiceNumber" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountCredited" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMPTZ(6),
    "dueAt" TIMESTAMPTZ(6),
    "paidAt" TIMESTAMPTZ(6),
    "voidedAt" TIMESTAMPTZ(6),
    "voidReason" TEXT,
    "billingPeriodStart" TIMESTAMPTZ(6),
    "billingPeriodEnd" TIMESTAMPTZ(6),
    "generationKey" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lineSubtotal" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "packageId" UUID,
    "periodStart" TIMESTAMPTZ(6),
    "periodEnd" TIMESTAMPTZ(6),

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "subscriberId" UUID NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "appliedToInvoice" DECIMAL(14,2) NOT NULL,
    "toCustomerCredit" DECIMAL(14,2) NOT NULL,
    "createdById" UUID,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteLine" (
    "id" UUID NOT NULL,
    "creditNoteId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "CreditNoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "subscriberId" UUID,
    "method" "PaymentMethod" NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerTransactionId" TEXT,
    "receiptNumber" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMPTZ(6),
    "payerName" TEXT,
    "payerPhone" TEXT,
    "accountReference" TEXT,
    "notes" TEXT,
    "allocatedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "recordedById" UUID,
    "reversedAt" TIMESTAMPTZ(6),
    "reversalReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMPTZ(6),
    "reversalReason" TEXT,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "subscriberId" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "refundedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "actorUserId" UUID,
    "actorType" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "subscriberId" UUID,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "categoryId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidAt" TIMESTAMPTZ(6) NOT NULL,
    "payee" TEXT,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "reversedAt" TIMESTAMPTZ(6),
    "reversalReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fromMethod" "PaymentMethod" NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "details" JSONB,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_dueAt_idx" ON "Invoice"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_subscriberId_createdAt_idx" ON "Invoice"("organizationId", "subscriberId", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_subscriptionId_idx" ON "Invoice"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_invoiceNumber_key" ON "Invoice"("organizationId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_generationKey_key" ON "Invoice"("organizationId", "generationKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_organizationId_creditNoteNumber_key" ON "CreditNote"("organizationId", "creditNoteNumber");

-- CreateIndex
CREATE INDEX "Payment_organizationId_status_receivedAt_idx" ON "Payment"("organizationId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "Payment_organizationId_subscriberId_idx" ON "Payment"("organizationId", "subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_organizationId_provider_providerTransactionId_key" ON "Payment"("organizationId", "provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_organizationId_receiptNumber_key" ON "Payment"("organizationId", "receiptNumber");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_invoiceId_idx" ON "PaymentAllocation"("invoiceId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Refund_organizationId_refundedAt_idx" ON "Refund"("organizationId", "refundedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_organizationId_code_key" ON "LedgerAccount"("organizationId", "code");

-- CreateIndex
CREATE INDEX "LedgerTransaction_organizationId_occurredAt_idx" ON "LedgerTransaction"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_organizationId_sourceType_sourceId_idx" ON "LedgerTransaction"("organizationId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "LedgerEntry_organizationId_accountId_idx" ON "LedgerEntry"("organizationId", "accountId");

-- CreateIndex
CREATE INDEX "LedgerEntry_organizationId_subscriberId_idx" ON "LedgerEntry"("organizationId", "subscriberId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_organizationId_name_key" ON "ExpenseCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Expense_organizationId_paidAt_idx" ON "Expense"("organizationId", "paidAt");

-- CreateIndex
CREATE INDEX "Withdrawal_organizationId_occurredAt_idx" ON "Withdrawal"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_organizationId_createdAt_idx" ON "ReconciliationRecord"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_paymentId_idx" ON "ReconciliationRecord"("paymentId");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteLine" ADD CONSTRAINT "CreditNoteLine_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════ Financial invariants (defence in depth; services enforce the same rules) ═══════════════

-- Ledger: every transaction must balance (sum of debits = sum of credits) and have at least two lines.
-- Deferred so all lines of a transaction can be inserted before the check runs at COMMIT.
CREATE FUNCTION cloudlink_ledger_assert_balanced() RETURNS trigger AS $$
DECLARE
  diff numeric;
  cnt integer;
BEGIN
  SELECT COALESCE(SUM("debit" - "credit"), 0), COUNT(*) INTO diff, cnt
  FROM "LedgerEntry" WHERE "transactionId" = NEW."transactionId";
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced by %', NEW."transactionId", diff USING ERRCODE = '23514';
  END IF;
  IF cnt < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % needs at least two entries', NEW."transactionId" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerEntry_balanced"
  AFTER INSERT ON "LedgerEntry" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cloudlink_ledger_assert_balanced();

-- Ledger rows are append-only: corrections are new reversing transactions.
CREATE FUNCTION cloudlink_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only" BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();
CREATE TRIGGER "LedgerTransaction_append_only" BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();
CREATE TRIGGER "Refund_append_only" BEFORE UPDATE OR DELETE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();
CREATE TRIGGER "CreditNote_append_only" BEFORE UPDATE OR DELETE ON "CreditNote"
  FOR EACH ROW EXECUTE FUNCTION cloudlink_forbid_mutation();

-- Invoice lines are immutable once the invoice leaves DRAFT.
CREATE FUNCTION cloudlink_invoice_line_guard() RETURNS trigger AS $$
DECLARE
  st "InvoiceStatus";
BEGIN
  SELECT "status" INTO st FROM "Invoice" WHERE "id" = COALESCE(NEW."invoiceId", OLD."invoiceId");
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of issued invoices are immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "InvoiceLine_immutable_after_issue" BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION cloudlink_invoice_line_guard();

-- Issued invoices: amounts, currency, customer and number are frozen; they can only be voided, never deleted or reopened.
CREATE FUNCTION cloudlink_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Issued invoices cannot be deleted; void them instead' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."total" <> OLD."total" OR NEW."subtotal" <> OLD."subtotal" OR NEW."taxTotal" <> OLD."taxTotal"
    OR NEW."discountTotal" <> OLD."discountTotal" OR NEW."currency" <> OLD."currency"
    OR NEW."invoiceNumber" IS DISTINCT FROM OLD."invoiceNumber" OR NEW."subscriberId" <> OLD."subscriberId"
    OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt") THEN
    RAISE EXCEPTION 'Issued invoice amounts are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" = 'VOID' AND NEW."status" <> 'VOID' THEN
    RAISE EXCEPTION 'Void invoices cannot be reopened' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" <> 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Issued invoices cannot return to draft' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "Invoice_issued_guard" BEFORE UPDATE OR DELETE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION cloudlink_invoice_guard();

-- Amount and consistency checks.
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amounts_nonnegative" CHECK ("subtotal" >= 0 AND "discountTotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0 AND "amountPaid" >= 0 AND "amountCredited" >= 0 AND "balanceDue" >= 0),
  ADD CONSTRAINT "Invoice_balance_consistent" CHECK ("status" = 'VOID' OR "balanceDue" = "total" - "amountPaid" - "amountCredited"),
  ADD CONSTRAINT "Invoice_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "Invoice_issued_has_number" CHECK ("status" = 'DRAFT' OR ("invoiceNumber" IS NOT NULL AND "issuedAt" IS NOT NULL));
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_values" CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "discount" >= 0 AND "taxRate" >= 0 AND "taxRate" <= 100 AND "lineTotal" >= 0 AND "taxAmount" >= 0);
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "Payment_settlement_within_amount" CHECK ("allocatedAmount" >= 0 AND "refundedAmount" >= 0 AND "allocatedAmount" + "refundedAmount" <= "amount"),
  ADD CONSTRAINT "Payment_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_amounts" CHECK ("total" > 0 AND "subtotal" >= 0 AND "taxTotal" >= 0 AND "appliedToInvoice" >= 0 AND "toCustomerCredit" >= 0 AND "appliedToInvoice" + "toCustomerCredit" = "total");
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0)));
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "BillingSettings" ADD CONSTRAINT "BillingSettings_days" CHECK ("invoiceLeadDays" >= 0 AND "invoiceLeadDays" <= 60 AND "paymentTermsDays" >= 0 AND "paymentTermsDays" <= 120);

COMMIT;
