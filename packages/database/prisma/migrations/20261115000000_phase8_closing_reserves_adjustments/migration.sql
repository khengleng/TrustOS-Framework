-- Phase 8, second pass — period closing, reserves and settlement adjustments.
--
-- Three specification items the first pass missed: `Closing` in the ledger, `Reserved Balance` in
-- the wallet, and `Settlement Adjustment`.
--
-- The hand-written section below carries the constraints that make the hold/reserve distinction
-- real. A `kind` column that the application respects and the database does not is a column that
-- one bad migration turns back into a single number — and the failure is silent, because a reserve
-- with an expiry looks exactly like a hold until the sweeper reaches it.

-- AlterTable
ALTER TABLE "wallet_hold" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'hold',
ALTER COLUMN "expiresAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "accounting_period" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "ledgerId" TEXT NOT NULL DEFAULT 'default',
    "code" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closingTotals" JSONB NOT NULL DEFAULT '[]',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closingNote" TEXT,
    "reopenings" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_adjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "batchId" TEXT NOT NULL,
    "instructionId" TEXT,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "counterAccountId" TEXT NOT NULL,
    "journalId" TEXT,
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "settlement_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_period_organizationId_ledgerId_startsAt_endsAt_idx" ON "accounting_period"("organizationId", "ledgerId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "settlement_adjustment_batchId_createdAt_idx" ON "settlement_adjustment"("batchId", "createdAt");

-- AddForeignKey
ALTER TABLE "settlement_adjustment" ADD CONSTRAINT "settlement_adjustment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "settlement_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written constraints and indexes.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. A hold expires; a reserve does not.
--
-- Both halves, because each protects against a different mistake. A hold with no expiry is money
-- the customer cannot spend and nobody is coming back for. A reserve *with* one is chargeback
-- cover that the sweeper eventually dissolves, silently, months after anybody remembers it was
-- set up.
-- --------------------------------------------------------------------------
ALTER TABLE "wallet_hold"
    ADD CONSTRAINT "wallet_hold_kind_valid" CHECK ("kind" IN ('hold', 'reserve'));

ALTER TABLE "wallet_hold"
    ADD CONSTRAINT "wallet_hold_expiry_matches_kind" CHECK (
        ("kind" = 'hold' AND "expiresAt" IS NOT NULL)
        OR ("kind" = 'reserve' AND "expiresAt" IS NULL)
    );

ALTER TABLE "wallet_hold"
    ADD CONSTRAINT "wallet_hold_amount_positive" CHECK ("amount" > 0);

-- The sweeper's index, now that it must exclude reserves. Partial on both conditions, because the
-- rows it wants are a small and shrinking fraction of a table that only grows.
DROP INDEX IF EXISTS "wallet_hold_expiring";

CREATE INDEX "wallet_hold_expiring"
    ON "wallet_hold" ("expiresAt")
    WHERE "status" = 'active' AND "kind" = 'hold';

-- --------------------------------------------------------------------------
-- 2. A period covers a window, and two periods may not cover the same instant.
--
-- PostgreSQL cannot express "no two ranges overlap" with a plain unique index; it needs an
-- exclusion constraint over a range type, which is exactly what this is for. Without it, a journal
-- belongs to two periods and which one a report uses depends on which query ran.
--
-- `btree_gist` is required because the constraint mixes equality (tenant, ledger) with range
-- overlap. It ships with PostgreSQL as a standard contrib module.
--
-- `tsrange`, not `tstzrange`: Prisma maps `DateTime` to `timestamp(3)` without a zone, and
-- converting one to a zoned range depends on the session timezone — which makes the expression
-- non-immutable and the index impossible. PostgreSQL says so plainly, and it is easy to misread as
-- a problem with the constraint rather than with the column type.
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "accounting_period"
    ADD CONSTRAINT "accounting_period_no_overlap" EXCLUDE USING gist (
        (COALESCE("organizationId", '')) WITH =,
        "ledgerId" WITH =,
        tsrange("startsAt", "endsAt", '[)') WITH &&
    );

ALTER TABLE "accounting_period"
    ADD CONSTRAINT "accounting_period_window_ordered" CHECK ("endsAt" > "startsAt");

ALTER TABLE "accounting_period"
    ADD CONSTRAINT "accounting_period_status_valid" CHECK ("status" IN ('open', 'closed'));

-- One code per ledger per tenant, so `2026-03` names one thing.
CREATE UNIQUE INDEX "accounting_period_scoped_code"
    ON "accounting_period" (COALESCE("organizationId", ''), "ledgerId", "code");

-- --------------------------------------------------------------------------
-- 3. An adjustment is signed and non-zero.
--
-- The only signed amount in the phase, and the check is that it is not zero: an adjustment of zero
-- corrects nothing and is a row somebody has to explain.
-- --------------------------------------------------------------------------
ALTER TABLE "settlement_adjustment"
    ADD CONSTRAINT "settlement_adjustment_amount_nonzero" CHECK ("amount" <> 0);

ALTER TABLE "settlement_adjustment"
    ADD CONSTRAINT "settlement_adjustment_kind_valid" CHECK (
        "kind" IN ('counterparty_fee', 'amount_difference', 'fx_difference', 'chargeback', 'other')
    );

-- A reason that is present but empty is the same as no reason, and it is the shape a form
-- submission produces.
ALTER TABLE "settlement_adjustment"
    ADD CONSTRAINT "settlement_adjustment_reason_present" CHECK (length(trim("reason")) > 0);
