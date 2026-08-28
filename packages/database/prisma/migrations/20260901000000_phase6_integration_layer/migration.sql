-- Phase 6 — the integration layer.
--
-- Sixteen tables: events, webhooks, jobs, schedules, imports, exports and synchronization.
--
-- Everything below the generated section is hand-written and is the part worth reading. Prisma
-- cannot express a partial index or an expression index, and three of the guarantees this phase
-- makes depend on exactly those. Each is explained where it appears.

-- CreateTable
CREATE TABLE "event_dead_letter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "subscriptionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "error" TEXT NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMP(3),
    "replayedById" TEXT,

    CONSTRAINT "event_dead_letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_delivery_ledger" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "deduplicationKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "handledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_delivery_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_secret" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "webhookEndpointId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "webhookEndpointId" TEXT NOT NULL,
    "eventPattern" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "webhook_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "webhookEndpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "responseTimeMs" INTEGER,
    "error" TEXT,
    "payload" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_attempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "webhookDeliveryId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "responseStatus" INTEGER,
    "error" TEXT,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "webhook_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "result" JSONB,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "jobId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "workerId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "outcome" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "intervalMs" INTEGER,
    "runAt" TIMESTAMP(3),
    "jobType" TEXT NOT NULL,
    "jobPayload" JSONB NOT NULL DEFAULT '{}',
    "misfirePolicy" TEXT NOT NULL DEFAULT 'run_once',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL,
    "jobId" TEXT,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "error" TEXT,

    CONSTRAINT "schedule_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsAccepted" INTEGER NOT NULL DEFAULT 0,
    "rowsRejected" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "appliedSummary" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "import_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "byteCount" INTEGER NOT NULL DEFAULT 0,
    "documentId" TEXT,
    "parameters" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "export_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "connectorKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "conflictPolicy" TEXT NOT NULL DEFAULT 'remote_wins',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "watermark" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "connectionId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsDeleted" INTEGER NOT NULL DEFAULT 0,
    "recordsSkipped" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "fromWatermark" TEXT,
    "toWatermark" TEXT,
    "error" TEXT,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflict" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "connectionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "remoteUpdatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "remoteData" JSONB NOT NULL,
    "localData" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "sync_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_dead_letter_organizationId_replayedAt_idx" ON "event_dead_letter"("organizationId", "replayedAt");

-- CreateIndex
CREATE INDEX "event_dead_letter_subscriptionId_failedAt_idx" ON "event_dead_letter"("subscriptionId", "failedAt");

-- CreateIndex
CREATE INDEX "event_dead_letter_eventName_idx" ON "event_dead_letter"("eventName");

-- CreateIndex
CREATE INDEX "event_delivery_ledger_handledAt_idx" ON "event_delivery_ledger"("handledAt");

-- CreateIndex
CREATE UNIQUE INDEX "event_delivery_ledger_deduplicationKey_key" ON "event_delivery_ledger"("deduplicationKey");

-- CreateIndex
CREATE INDEX "webhook_endpoint_organizationId_status_idx" ON "webhook_endpoint"("organizationId", "status");

-- CreateIndex
CREATE INDEX "webhook_secret_webhookEndpointId_revokedAt_expiresAt_idx" ON "webhook_secret"("webhookEndpointId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "webhook_subscription_organizationId_idx" ON "webhook_subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscription_webhookEndpointId_eventPattern_key" ON "webhook_subscription"("webhookEndpointId", "eventPattern");

-- CreateIndex
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx" ON "webhook_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "webhook_delivery_organizationId_createdAt_idx" ON "webhook_delivery"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_delivery_eventName_idx" ON "webhook_delivery"("eventName");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_webhookEndpointId_eventId_key" ON "webhook_delivery"("webhookEndpointId", "eventId");

-- CreateIndex
CREATE INDEX "webhook_attempt_webhookDeliveryId_attempt_idx" ON "webhook_attempt"("webhookDeliveryId", "attempt");

-- CreateIndex
CREATE INDEX "job_status_runAt_priority_idx" ON "job"("status", "runAt", "priority");

-- CreateIndex
CREATE INDEX "job_status_leaseExpiresAt_idx" ON "job"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "job_organizationId_status_createdAt_idx" ON "job"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "job_type_status_idx" ON "job"("type", "status");

-- CreateIndex
CREATE INDEX "job_run_jobId_attempt_idx" ON "job_run"("jobId", "attempt");

-- CreateIndex
CREATE INDEX "schedule_status_nextRunAt_idx" ON "schedule"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_organizationId_key_key" ON "schedule"("organizationId", "key");

-- CreateIndex
CREATE INDEX "schedule_run_scheduleId_firedAt_idx" ON "schedule_run"("scheduleId", "firedAt");

-- CreateIndex
CREATE INDEX "import_run_organizationId_type_startedAt_idx" ON "import_run"("organizationId", "type", "startedAt");

-- CreateIndex
CREATE INDEX "import_run_status_idx" ON "import_run"("status");

-- CreateIndex
CREATE INDEX "export_run_organizationId_type_startedAt_idx" ON "export_run"("organizationId", "type", "startedAt");

-- CreateIndex
CREATE INDEX "sync_connection_status_idx" ON "sync_connection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sync_connection_organizationId_connectorKey_name_key" ON "sync_connection"("organizationId", "connectorKey", "name");

-- CreateIndex
CREATE INDEX "sync_run_connectionId_startedAt_idx" ON "sync_run"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "sync_conflict_connectionId_resolvedAt_idx" ON "sync_conflict"("connectionId", "resolvedAt");

-- CreateIndex
CREATE INDEX "sync_conflict_organizationId_resolvedAt_idx" ON "sync_conflict"("organizationId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "webhook_secret" ADD CONSTRAINT "webhook_secret_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscription" ADD CONSTRAINT "webhook_subscription_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_attempt" ADD CONSTRAINT "webhook_attempt_webhookDeliveryId_fkey" FOREIGN KEY ("webhookDeliveryId") REFERENCES "webhook_delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "sync_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflict" ADD CONSTRAINT "sync_conflict_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "sync_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express
-- ---------------------------------------------------------------------------

-- One live job per idempotency key.
--
-- Partial, over non-terminal jobs only. "Rebuild this report", clicked twice in one second, must
-- produce one job — and a check-then-insert loses that race precisely under the load where it
-- matters. This constraint is what makes `JobStore.insert` correct rather than hopeful.
--
-- The partial predicate is the other half: without it a nightly job keyed by its date could
-- never re-run after a failure, because the finished row would still hold the key.
--
-- COALESCE, because a NULL organizationId is a platform job and PostgreSQL treats NULLs as
-- distinct in a unique index — so two platform jobs with the same key would both be allowed,
-- which is the one case the constraint exists to prevent.
CREATE UNIQUE INDEX "job_active_idempotency_key"
  ON "job" (COALESCE("organizationId", ''), "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL AND "status" IN ('queued', 'running');

-- One schedule per key, including at platform scope.
--
-- Prisma's `@@unique([organizationId, key])` is generated above and does not cover the
-- platform case, for the NULL reason described on the job index. A duplicate platform schedule
-- would fire the same job twice, every time, forever.
CREATE UNIQUE INDEX "schedule_scoped_key"
  ON "schedule" (COALESCE("organizationId", ''), "key");

-- One sync connection per connector and name, including at platform scope.
CREATE UNIQUE INDEX "sync_connection_scoped_key"
  ON "sync_connection" (COALESCE("organizationId", ''), "connectorKey", "name");

-- The delivery worker's poll.
--
-- Partial, so the index holds only rows that are actually due rather than every delivery ever
-- made. On a table with ten million completed deliveries and forty pending ones, this is the
-- difference between a millisecond and a sequential scan every second.
CREATE INDEX "webhook_delivery_due"
  ON "webhook_delivery" ("nextAttemptAt")
  WHERE "status" = 'pending';

-- The job worker's poll, for the same reason.
CREATE INDEX "job_runnable"
  ON "job" ("priority", "runAt")
  WHERE "status" = 'queued';

-- Reclaiming jobs from a worker that died.
CREATE INDEX "job_expired_lease"
  ON "job" ("leaseExpiresAt")
  WHERE "status" = 'running';

-- The scheduler's tick.
CREATE INDEX "schedule_due"
  ON "schedule" ("nextRunAt")
  WHERE "status" = 'active';

-- Unreplayed dead letters, which is the only query the health check makes of this table.
CREATE INDEX "event_dead_letter_unreplayed"
  ON "event_dead_letter" ("organizationId", "failedAt")
  WHERE "replayedAt" IS NULL;

-- Unresolved sync conflicts, likewise.
CREATE INDEX "sync_conflict_unresolved"
  ON "sync_conflict" ("organizationId", "detectedAt")
  WHERE "resolvedAt" IS NULL;
