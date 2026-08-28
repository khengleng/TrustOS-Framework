-- Phase 8 — the financial platform.
--
-- Nineteen tables: the ledger, accounts, wallets, transactions, payments, fees, limits, rates,
-- settlement, reconciliation, policy and compliance records.
--
-- Everything below the generated section is hand-written and is the part worth reading. Three of
-- this phase's four guarantees are enforced here rather than only in the application, because the
-- application's own database credentials can do everything the application refuses to:
--
--   1. A journal must balance. A deferred constraint trigger checks it at commit.
--   2. A posted journal is immutable. A trigger refuses UPDATE and DELETE.
--   3. An entry amount is positive. A check constraint.
--
-- The fourth — money is never a float — is in the column types above.

-- CreateTable
CREATE TABLE "ledger_journal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ledgerId" TEXT NOT NULL DEFAULT 'default',
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "reversedByJournalId" TEXT,
    "reversesJournalId" TEXT,
    "contentHash" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ledger_journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "organizationId" TEXT,
    "accountId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "dimension" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ownerId" TEXT,
    "ownerType" TEXT,
    "ledgerId" TEXT NOT NULL DEFAULT 'default',
    "parentAccountId" TEXT,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "overdraftLimit" DECIMAL(28,8),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "financial_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ownerId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'user',
    "name" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "frozenAt" TIMESTAMP(3),
    "frozenReason" TEXT,
    "limitKeys" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_hold" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "walletId" TEXT NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "capturedAmount" DECIMAL(28,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedReason" TEXT,

    CONSTRAINT "wallet_hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "feeAmount" DECIMAL(28,8),
    "feeBreakdown" JSONB,
    "sourceWalletId" TEXT,
    "sourceAccountId" TEXT,
    "destinationWalletId" TEXT,
    "destinationAccountId" TEXT,
    "holdId" TEXT,
    "journalIds" TEXT[],
    "idempotencyKey" TEXT,
    "reference" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "parentTransactionId" TEXT,
    "refundedAmount" DECIMAL(28,8),
    "failureReason" TEXT,
    "failureCode" TEXT,
    "riskScore" INTEGER,
    "riskDecision" TEXT,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "financial_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transaction_event" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "organizationId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "journalId" TEXT,

    CONSTRAINT "financial_transaction_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_request" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAmount" DECIMAL(28,8),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payeeAccountId" TEXT,
    "payeeWalletId" TEXT,
    "payerId" TEXT,
    "invoiceReference" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "allowPartial" BOOLEAN NOT NULL DEFAULT false,
    "callbackUrl" TEXT,
    "providerReference" TEXT,
    "provider" TEXT,
    "transactionIds" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,

    CONSTRAINT "payment_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "minimumFee" DECIMAL(28,8),
    "maximumFee" DECIMAL(28,8),
    "rounding" TEXT NOT NULL DEFAULT 'half_even',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "promotional" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,

    CONSTRAINT "fee_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_limit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "rollingMs" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" TEXT,
    "maxAmount" DECIMAL(28,8),
    "maxCount" INTEGER,
    "enforcement" TEXT NOT NULL DEFAULT 'block',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_limit_usage" (
    "id" TEXT NOT NULL,
    "limitId" TEXT NOT NULL,
    "organizationId" TEXT,
    "subjectId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(28,8),
    "currency" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_limit_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DECIMAL(28,12) NOT NULL,
    "source" TEXT NOT NULL,
    "quotedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_batch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "reference" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "settlementAccountId" TEXT NOT NULL,
    "instructionCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(28,8) NOT NULL,
    "journalIds" TEXT[],
    "externalReference" TEXT,
    "failureReason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "settlement_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_instruction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "batchId" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "counterpartyName" TEXT NOT NULL DEFAULT '',
    "sourceAccountId" TEXT NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transactionIds" TEXT[],
    "externalReference" TEXT,
    "failureReason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "settlement_instruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "internalCount" INTEGER NOT NULL DEFAULT 0,
    "externalCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "exceptionCount" INTEGER NOT NULL DEFAULT 0,
    "internalTotal" DECIMAL(28,8) NOT NULL,
    "externalTotal" DECIMAL(28,8) NOT NULL,
    "difference" DECIMAL(28,8) NOT NULL,
    "tolerance" JSONB NOT NULL,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedById" TEXT,

    CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_exception" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reference" TEXT NOT NULL,
    "internalAmount" DECIMAL(28,8),
    "externalAmount" DECIMAL(28,8),
    "difference" DECIMAL(28,8),
    "currency" TEXT NOT NULL,
    "internalId" TEXT,
    "externalId" TEXT,
    "internalAt" TIMESTAMP(3),
    "externalAt" TIMESTAMP(3),
    "detail" TEXT NOT NULL,
    "assignedTo" TEXT,
    "resolution" TEXT,
    "correctionJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "reconciliation_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_policy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeTarget" TEXT,
    "allowedCurrencies" TEXT[],
    "allowNegativeBalance" BOOLEAN NOT NULL DEFAULT false,
    "overdraftLimits" JSONB NOT NULL DEFAULT '{}',
    "approvalThresholds" JSONB NOT NULL DEFAULT '{}',
    "highValueThresholds" JSONB NOT NULL DEFAULT '{}',
    "allowRiskReviewToProceed" BOOLEAN NOT NULL DEFAULT false,
    "settlementWindowMs" INTEGER,
    "settlementAccountCodes" JSONB NOT NULL DEFAULT '{}',
    "feeScheduleKeys" JSONB NOT NULL DEFAULT '{}',
    "requireApprovalForReversal" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_status" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "subjectId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'user',
    "level" TEXT NOT NULL,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "pep" BOOLEAN NOT NULL DEFAULT false,
    "sanctioned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suspicious_activity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "subjectId" TEXT NOT NULL,
    "transactionIds" TEXT[],
    "trigger" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedTo" TEXT,
    "conclusion" TEXT,
    "reportedTo" TEXT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suspicious_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_journal_organizationId_ledgerId_effectiveAt_idx" ON "ledger_journal"("organizationId", "ledgerId", "effectiveAt");

-- CreateIndex
CREATE INDEX "ledger_journal_organizationId_reference_idx" ON "ledger_journal"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "ledger_entry_organizationId_accountId_currency_idx" ON "ledger_entry"("organizationId", "accountId", "currency");

-- CreateIndex
CREATE INDEX "ledger_entry_journalId_idx" ON "ledger_entry"("journalId");

-- CreateIndex
CREATE INDEX "financial_account_organizationId_type_status_idx" ON "financial_account"("organizationId", "type", "status");

-- CreateIndex
CREATE INDEX "financial_account_organizationId_ownerId_idx" ON "financial_account"("organizationId", "ownerId");

-- CreateIndex
CREATE INDEX "wallet_organizationId_ownerId_idx" ON "wallet"("organizationId", "ownerId");

-- CreateIndex
CREATE INDEX "wallet_hold_walletId_status_idx" ON "wallet_hold"("walletId", "status");

-- CreateIndex
CREATE INDEX "financial_transaction_organizationId_status_createdAt_idx" ON "financial_transaction"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "financial_transaction_organizationId_sourceWalletId_created_idx" ON "financial_transaction"("organizationId", "sourceWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "financial_transaction_organizationId_reference_idx" ON "financial_transaction"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "financial_transaction_event_transactionId_at_idx" ON "financial_transaction_event"("transactionId", "at");

-- CreateIndex
CREATE INDEX "payment_request_organizationId_status_expiresAt_idx" ON "payment_request"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "payment_request_organizationId_invoiceReference_idx" ON "payment_request"("organizationId", "invoiceReference");

-- CreateIndex
CREATE INDEX "fee_schedule_organizationId_key_status_effectiveFrom_idx" ON "fee_schedule"("organizationId", "key", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "fee_schedule_organizationId_key_version_key" ON "fee_schedule"("organizationId", "key", "version");

-- CreateIndex
CREATE INDEX "financial_limit_organizationId_scope_enabled_idx" ON "financial_limit"("organizationId", "scope", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "financial_limit_usage_limitId_subjectId_windowStart_key" ON "financial_limit_usage"("limitId", "subjectId", "windowStart");

-- CreateIndex
CREATE INDEX "exchange_rate_organizationId_fromCurrency_toCurrency_quoted_idx" ON "exchange_rate"("organizationId", "fromCurrency", "toCurrency", "quotedAt");

-- CreateIndex
CREATE INDEX "settlement_batch_organizationId_status_windowEnd_idx" ON "settlement_batch"("organizationId", "status", "windowEnd");

-- CreateIndex
CREATE INDEX "settlement_instruction_batchId_status_idx" ON "settlement_instruction"("batchId", "status");

-- CreateIndex
CREATE INDEX "settlement_instruction_organizationId_counterpartyId_idx" ON "settlement_instruction"("organizationId", "counterpartyId");

-- CreateIndex
CREATE INDEX "reconciliation_run_organizationId_key_startedAt_idx" ON "reconciliation_run"("organizationId", "key", "startedAt");

-- CreateIndex
CREATE INDEX "reconciliation_exception_organizationId_status_createdAt_idx" ON "reconciliation_exception"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "reconciliation_exception_runId_kind_idx" ON "reconciliation_exception"("runId", "kind");

-- CreateIndex
CREATE INDEX "financial_policy_organizationId_scopeKind_idx" ON "financial_policy"("organizationId", "scopeKind");

-- CreateIndex
CREATE INDEX "kyc_status_organizationId_subjectId_idx" ON "kyc_status"("organizationId", "subjectId");

-- CreateIndex
CREATE INDEX "suspicious_activity_organizationId_status_createdAt_idx" ON "suspicious_activity"("organizationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "ledger_journal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "financial_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_hold" ADD CONSTRAINT "wallet_hold_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transaction_event" ADD CONSTRAINT "financial_transaction_event_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_limit_usage" ADD CONSTRAINT "financial_limit_usage_limitId_fkey" FOREIGN KEY ("limitId") REFERENCES "financial_limit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_instruction" ADD CONSTRAINT "settlement_instruction_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "settlement_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exception" ADD CONSTRAINT "reconciliation_exception_runId_fkey" FOREIGN KEY ("runId") REFERENCES "reconciliation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written constraints, indexes and triggers.
--
-- Prisma cannot express a check constraint, a partial index, an expression index or a trigger.
-- Each one below is here because the alternative is a guarantee that holds only while every
-- caller remembers.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. An entry amount is positive.
--
-- The direction carries the sign. A negative debit and a credit are the same movement written two
-- ways, and a ledger that stores both has two representations of every posting — so a report
-- grouped by direction is wrong in a way nothing detects.
-- --------------------------------------------------------------------------
ALTER TABLE "ledger_entry"
    ADD CONSTRAINT "ledger_entry_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "ledger_entry"
    ADD CONSTRAINT "ledger_entry_direction_valid" CHECK ("direction" IN ('debit', 'credit'));

-- --------------------------------------------------------------------------
-- 2. A posted journal must balance, per currency.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger, so it fires once at COMMIT rather than after
-- each row. A non-deferred trigger would fire after the first entry and refuse every journal ever
-- written, because one entry never balances.
--
-- This is the guarantee everything else in the phase rests on. The service checks it before
-- posting; this is what holds when somebody writes rows with psql, or when a future code path
-- forgets.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustos_journal_must_balance() RETURNS trigger AS $$
DECLARE
    unbalanced RECORD;
BEGIN
    -- A draft journal is a work in progress and is allowed not to balance. Only posted and
    -- reversed journals are included in any balance, so only those must add up.
    IF NOT EXISTS (
        SELECT 1 FROM "ledger_journal"
        WHERE "id" = COALESCE(NEW."journalId", OLD."journalId")
          AND "status" IN ('posted', 'reversed')
    ) THEN
        RETURN NULL;
    END IF;

    SELECT
        e."currency",
        SUM(CASE WHEN e."direction" = 'debit' THEN e."amount" ELSE 0 END) AS debits,
        SUM(CASE WHEN e."direction" = 'credit' THEN e."amount" ELSE 0 END) AS credits
    INTO unbalanced
    FROM "ledger_entry" e
    WHERE e."journalId" = COALESCE(NEW."journalId", OLD."journalId")
    GROUP BY e."currency"
    HAVING SUM(CASE WHEN e."direction" = 'debit' THEN e."amount" ELSE 0 END)
         <> SUM(CASE WHEN e."direction" = 'credit' THEN e."amount" ELSE 0 END)
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'journal % does not balance in %: debits %, credits %',
            COALESCE(NEW."journalId", OLD."journalId"),
            unbalanced."currency",
            unbalanced.debits,
            unbalanced.credits
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entry_journal_balances
    AFTER INSERT OR UPDATE OR DELETE ON "ledger_entry"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION trustos_journal_must_balance();

-- --------------------------------------------------------------------------
-- 3. A posted journal is immutable.
--
-- Two triggers: one on the journal, one on its entries. The journal one permits exactly the
-- changes a reversal makes — `status`, `reversedByJournalId` and `updatedAt` — because marking a
-- journal reversed is a legitimate change and the content hash is computed to exclude it.
--
-- As with the audit log in phase 1: a BEFORE trigger applies to the table owner, which a REVOKE
-- does not. It is a control against application bugs, a compromised application role and
-- well-meaning manual edits — not against a determined database administrator.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustos_journal_immutable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" IN ('posted', 'reversed') THEN
            RAISE EXCEPTION
                'journal % is posted and cannot be deleted: a correction is a new journal', OLD."id"
                USING ERRCODE = 'insufficient_privilege';
        END IF;

        RETURN OLD;
    END IF;

    IF OLD."status" = 'draft' THEN
        RETURN NEW;
    END IF;

    -- The only permitted change to a posted journal: recording that a reversal exists.
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
       OR NEW."ledgerId" IS DISTINCT FROM OLD."ledgerId"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."description" IS DISTINCT FROM OLD."description"
       OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
       OR NEW."postedAt" IS DISTINCT FROM OLD."postedAt"
       OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
       OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    THEN
        RAISE EXCEPTION
            'journal % is posted and is immutable: only a reversal may change it', OLD."id"
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_journal_immutable
    BEFORE UPDATE OR DELETE ON "ledger_journal"
    FOR EACH ROW
    EXECUTE FUNCTION trustos_journal_immutable();

CREATE OR REPLACE FUNCTION trustos_entry_immutable() RETURNS trigger AS $$
DECLARE
    journal_status TEXT;
BEGIN
    SELECT "status" INTO journal_status
    FROM "ledger_journal"
    WHERE "id" = COALESCE(OLD."journalId", NEW."journalId");

    -- A journal deleted in the same statement takes its entries with it, and the row is already
    -- gone by the time this fires. Nothing to protect.
    IF journal_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF journal_status IN ('posted', 'reversed') THEN
        RAISE EXCEPTION
            'entry % belongs to posted journal % and cannot be %d: a correction is a new journal',
            OLD."id", OLD."journalId", TG_OP
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_immutable
    BEFORE UPDATE OR DELETE ON "ledger_entry"
    FOR EACH ROW
    EXECUTE FUNCTION trustos_entry_immutable();

-- --------------------------------------------------------------------------
-- 4. Idempotency, per tenant.
--
-- COALESCE on the organization, because PostgreSQL treats NULL as distinct from NULL — a plain
-- unique constraint would accept unlimited platform-level postings with the same key, and the
-- retry that was supposed to be suppressed would post a second time.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX "ledger_journal_idempotency"
    ON "ledger_journal" (COALESCE("organizationId", ''), "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

CREATE UNIQUE INDEX "financial_transaction_idempotency"
    ON "financial_transaction" (COALESCE("organizationId", ''), "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

-- --------------------------------------------------------------------------
-- 5. One code per account, one wallet per owner and currency.
--
-- The account code is what application code looks accounts up by, and the wallet is "the
-- customer's USD balance". Two rows answering to either question makes the answer a function of
-- row order.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX "financial_account_scoped_code"
    ON "financial_account" (COALESCE("organizationId", ''), "code");

CREATE UNIQUE INDEX "wallet_owner_currency"
    ON "wallet" (COALESCE("organizationId", ''), "ownerId", "currency");

CREATE UNIQUE INDEX "payment_request_scoped_reference"
    ON "payment_request" (COALESCE("organizationId", ''), "reference");

CREATE UNIQUE INDEX "settlement_batch_scoped_reference"
    ON "settlement_batch" (COALESCE("organizationId", ''), "reference");

-- --------------------------------------------------------------------------
-- 6. One live fee schedule per key.
--
-- Partial on the open-ended version. Two rows claiming to price the same thing right now makes
-- which one applies depend on row order — so the same transaction is priced differently on
-- different days, and the invoice cannot be reproduced.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX "fee_schedule_single_live"
    ON "fee_schedule" (COALESCE("organizationId", ''), "key")
    WHERE "status" = 'published' AND "effectiveTo" IS NULL;

-- --------------------------------------------------------------------------
-- 7. One rate per pair, per source, per instant.
--
-- Two rates quoted at the same moment by the same source is a duplicate import, and which one a
-- conversion uses would decide what a customer paid.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX "exchange_rate_scoped_quote"
    ON "exchange_rate" (
        COALESCE("organizationId", ''),
        "fromCurrency",
        "toCurrency",
        "source",
        "quotedAt"
    );

-- --------------------------------------------------------------------------
-- 8. Sweeper indexes.
--
-- Partial, because in each case the rows the sweeper wants are a small and shrinking fraction of a
-- table that only grows. A full index on (status, expiresAt) would be mostly resolved rows nobody
-- queries by expiry.
-- --------------------------------------------------------------------------
CREATE INDEX "wallet_hold_expiring"
    ON "wallet_hold" ("expiresAt")
    WHERE "status" = 'active';

CREATE INDEX "financial_transaction_expiring"
    ON "financial_transaction" ("expiresAt")
    WHERE "status" = 'authorized' AND "expiresAt" IS NOT NULL;

CREATE INDEX "payment_request_expiring"
    ON "payment_request" ("expiresAt")
    WHERE "status" IN ('pending', 'processing', 'partially_paid');

-- --------------------------------------------------------------------------
-- 9. The exception queue.
--
-- "What is open, oldest first" is the query somebody runs every morning, and it should not scan
-- every difference ever resolved.
-- --------------------------------------------------------------------------
CREATE INDEX "reconciliation_exception_open"
    ON "reconciliation_exception" ("organizationId", "createdAt")
    WHERE "status" IN ('open', 'investigating');

-- --------------------------------------------------------------------------
-- 10. One policy per scope.
--
-- `FinancialPolicyEngine.resolve` picks the most specific and never merges. Two rows at one scope
-- would make "most specific" ambiguous and reintroduce the merge it avoids.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX "financial_policy_scoped_target"
    ON "financial_policy" (
        COALESCE("organizationId", ''),
        "scopeKind",
        COALESCE("scopeTarget", '')
    );

-- --------------------------------------------------------------------------
-- 11. One KYC record per subject.
--
-- Two records for one person means one of them is stale, and the query that finds the stale one
-- first reports a customer as unverified — or, worse, as verified.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX "kyc_status_subject"
    ON "kyc_status" (COALESCE("organizationId", ''), "subjectId", "subjectType");
