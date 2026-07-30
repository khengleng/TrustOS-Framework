-- Phase 7 — the AI platform.
--
-- Seventeen tables: models, prompts, policy, request log, conversations, memory, agent runs,
-- review, knowledge, vectors, cache and evaluation.
--
-- Everything below the generated section is hand-written and is the part worth reading. Prisma
-- cannot express a partial index or an expression index, and several of this phase's guarantees
-- depend on exactly those — most importantly that a tenant's null organization is one tenant
-- rather than a wildcard, which PostgreSQL will not enforce through a plain unique constraint
-- because it treats NULLs as distinct from each other.

-- CreateTable
CREATE TABLE "ai_model" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "family" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "statusReason" TEXT,
    "contextTokens" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL,
    "capabilities" TEXT[],
    "inputCostPerMillion" INTEGER NOT NULL,
    "outputCostPerMillion" INTEGER NOT NULL,
    "cachedInputCostPerMillion" INTEGER,
    "pricingUpdatedAt" TIMESTAMP(3) NOT NULL,
    "p50LatencyMs" INTEGER,
    "allowedOrganizationIds" TEXT[],
    "unavailableUntil" TIMESTAMP(3),
    "unavailableReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prompt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prompt_version" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "organizationId" TEXT,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "template" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "modelId" TEXT,
    "safetyProfile" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_prompt_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_policy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeTarget" TEXT,
    "allowedModels" TEXT[],
    "deniedModels" TEXT[],
    "allowedProviders" TEXT[],
    "allowedTools" TEXT[],
    "allowedKnowledgeBases" TEXT[],
    "maxOutputTokens" INTEGER,
    "maxRuntimeMs" INTEGER,
    "maxAgentSteps" INTEGER,
    "maxCostCentsPerRequest" INTEGER,
    "maxCostCentsPerDay" INTEGER,
    "maxCostCentsPerMonth" INTEGER,
    "guardrailProfile" TEXT,
    "reviewAllOutput" BOOLEAN NOT NULL DEFAULT false,
    "allowCaching" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_request_log" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "application" TEXT NOT NULL DEFAULT 'unknown',
    "actorId" TEXT,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fallbackFrom" TEXT,
    "agentId" TEXT,
    "promptKey" TEXT,
    "promptVersion" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "finishReason" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedPromptTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" DECIMAL(14,6) NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "agentId" TEXT,
    "title" TEXT,
    "summary" TEXT,
    "summarisedMessageCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCostCents" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation_turn" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "organizationId" TEXT,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "toolCalls" JSONB,
    "toolCallId" TEXT,
    "modelId" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversation_turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_memory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "sessionId" TEXT,
    "agentId" TEXT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'inferred',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_agent_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "agentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "actorId" TEXT,
    "application" TEXT,
    "stopReason" TEXT NOT NULL,
    "limitHit" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCostCents" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ai_agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_run_step" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "organizationId" TEXT,
    "step" INTEGER NOT NULL,
    "modelId" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_run_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_review_request" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "prompt" TEXT,
    "agentId" TEXT,
    "modelId" TEXT,
    "reason" TEXT NOT NULL,
    "signals" TEXT[],
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT,
    "assignedTo" TEXT,
    "requiredPermission" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "correctedContent" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_review_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_collection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'restricted',
    "readPermissions" TEXT[],
    "writePermissions" TEXT[],
    "embeddingModelId" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "embeddingVersion" TEXT NOT NULL DEFAULT '1',
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_document" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "organizationId" TEXT,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "uri" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "embeddedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_vector_record" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "collectionId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "vector" JSONB NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "documentId" TEXT,
    "title" TEXT,
    "uri" TEXT,
    "section" TEXT,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_vector_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_cache_entry" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "organizationId" TEXT,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "content" TEXT,
    "toolCalls" JSONB,
    "usage" JSONB NOT NULL,
    "costCents" DECIMAL(14,6) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_cache_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "suiteId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "scores" JSONB NOT NULL DEFAULT '{}',
    "totalCostCents" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_evaluation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_case_result" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "organizationId" TEXT,
    "caseId" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '[]',
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "failures" TEXT[],
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "costCents" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "ai_evaluation_case_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_model_organizationId_status_idx" ON "ai_model"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ai_model_provider_status_idx" ON "ai_model"("provider", "status");

-- CreateIndex
CREATE INDEX "ai_prompt_organizationId_key_idx" ON "ai_prompt"("organizationId", "key");

-- CreateIndex
CREATE INDEX "ai_prompt_version_organizationId_status_idx" ON "ai_prompt_version"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompt_version_promptId_version_key" ON "ai_prompt_version"("promptId", "version");

-- CreateIndex
CREATE INDEX "ai_policy_organizationId_scopeKind_idx" ON "ai_policy"("organizationId", "scopeKind");

-- CreateIndex
CREATE INDEX "ai_request_log_organizationId_at_idx" ON "ai_request_log"("organizationId", "at");

-- CreateIndex
CREATE INDEX "ai_request_log_organizationId_modelId_at_idx" ON "ai_request_log"("organizationId", "modelId", "at");

-- CreateIndex
CREATE INDEX "ai_request_log_organizationId_agentId_at_idx" ON "ai_request_log"("organizationId", "agentId", "at");

-- CreateIndex
CREATE INDEX "ai_conversation_organizationId_userId_updatedAt_idx" ON "ai_conversation"("organizationId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_conversation_organizationId_agentId_updatedAt_idx" ON "ai_conversation"("organizationId", "agentId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_conversation_turn_conversationId_createdAt_idx" ON "ai_conversation_turn"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_conversation_turn_conversationId_sequence_key" ON "ai_conversation_turn"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "ai_agent_memory_organizationId_scope_lastAccessedAt_idx" ON "ai_agent_memory"("organizationId", "scope", "lastAccessedAt");

-- CreateIndex
CREATE INDEX "ai_agent_memory_organizationId_conversationId_idx" ON "ai_agent_memory"("organizationId", "conversationId");

-- CreateIndex
CREATE INDEX "ai_agent_memory_organizationId_userId_idx" ON "ai_agent_memory"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "ai_agent_memory_expiresAt_idx" ON "ai_agent_memory"("expiresAt");

-- CreateIndex
CREATE INDEX "ai_agent_run_organizationId_agentId_startedAt_idx" ON "ai_agent_run"("organizationId", "agentId", "startedAt");

-- CreateIndex
CREATE INDEX "ai_agent_run_organizationId_stopReason_startedAt_idx" ON "ai_agent_run"("organizationId", "stopReason", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_run_step_runId_step_key" ON "ai_agent_run_step"("runId", "step");

-- CreateIndex
CREATE INDEX "ai_review_request_organizationId_status_priority_createdAt_idx" ON "ai_review_request"("organizationId", "status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "ai_review_request_organizationId_assignedTo_status_idx" ON "ai_review_request"("organizationId", "assignedTo", "status");

-- CreateIndex
CREATE INDEX "ai_knowledge_collection_organizationId_visibility_idx" ON "ai_knowledge_collection"("organizationId", "visibility");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_organizationId_collectionId_updatedAt_idx" ON "ai_knowledge_document"("organizationId", "collectionId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_vector_record_organizationId_collectionId_idx" ON "ai_vector_record"("organizationId", "collectionId");

-- CreateIndex
CREATE INDEX "ai_vector_record_collectionId_documentId_idx" ON "ai_vector_record"("collectionId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_cache_entry_cacheKey_key" ON "ai_cache_entry"("cacheKey");

-- CreateIndex
CREATE INDEX "ai_cache_entry_organizationId_expiresAt_idx" ON "ai_cache_entry"("organizationId", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_cache_entry_expiresAt_idx" ON "ai_cache_entry"("expiresAt");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_organizationId_suiteId_startedAt_idx" ON "ai_evaluation_run"("organizationId", "suiteId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_evaluation_case_result_runId_caseId_key" ON "ai_evaluation_case_result"("runId", "caseId");

-- AddForeignKey
ALTER TABLE "ai_prompt_version" ADD CONSTRAINT "ai_prompt_version_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "ai_prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation_turn" ADD CONSTRAINT "ai_conversation_turn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_run_step" ADD CONSTRAINT "ai_agent_run_step_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_agent_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document" ADD CONSTRAINT "ai_knowledge_document_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ai_knowledge_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_case_result" ADD CONSTRAINT "ai_evaluation_case_result_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_evaluation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written constraints and indexes.
--
-- Prisma cannot express any of these. Each one is here because the alternative is a bug that
-- does not announce itself.
-- ===========================================================================

-- One registry entry per model id per tenant.
--
-- COALESCE, not a plain unique on (organizationId, modelId): PostgreSQL treats NULL as distinct
-- from NULL, so a plain constraint would happily accept twenty platform-level rows for the same
-- model — and the registry would then return whichever one the planner reached first.
CREATE UNIQUE INDEX "ai_model_scoped_id"
    ON "ai_model" (COALESCE("organizationId", ''), "modelId");

-- One prompt per key per tenant. Same reasoning.
CREATE UNIQUE INDEX "ai_prompt_scoped_key"
    ON "ai_prompt" (COALESCE("organizationId", ''), "key");

-- At most one published version of a prompt at a time.
--
-- This is what makes "which version am I running" have an answer. Without it, publishing without
-- retiring the previous version leaves two rows claiming to be live, and which one renders is a
-- function of row order — so the same request produces different prompts on different days, and
-- nothing in the application looks wrong.
CREATE UNIQUE INDEX "ai_prompt_single_published"
    ON "ai_prompt_version" ("promptId")
    WHERE "status" = 'published';

-- One policy per scope.
--
-- `AiPolicyEngine.resolve` picks the most specific policy and never merges, because a merge
-- produces a policy nobody wrote. Two rows at the same scope would make "most specific" ambiguous
-- and reintroduce exactly that.
CREATE UNIQUE INDEX "ai_policy_scoped_target"
    ON "ai_policy" (COALESCE("organizationId", ''), "scopeKind", COALESCE("scopeTarget", ''));

-- One memory per key per subject.
--
-- Remembering the same thing twice updates rather than accumulating. Without this, an agent that
-- writes "the user prefers Khmer" on every turn fills the recall budget with forty copies of one
-- fact and pushes everything else out.
CREATE UNIQUE INDEX "ai_agent_memory_scoped_key"
    ON "ai_agent_memory" (
        COALESCE("organizationId", ''),
        "scope",
        COALESCE("agentId", ''),
        COALESCE("userId", ''),
        COALESCE("conversationId", ''),
        COALESCE("sessionId", ''),
        "key"
    );

-- The review queue's own query: what is pending and overdue.
--
-- Partial, because the pending rows are a small and shrinking fraction of a review table that
-- only grows. A full index on (organizationId, dueAt) would be mostly decided rows nobody
-- queries by due date.
CREATE INDEX "ai_review_pending_due"
    ON "ai_review_request" ("organizationId", "dueAt")
    WHERE "status" = 'pending';

-- Runs that need review and have none.
--
-- The gap that matters: an agent whose output requires a person, where the review was never
-- raised. A run in this state has produced output nobody will ever check, and nothing else in
-- the system will notice.
CREATE INDEX "ai_agent_run_review_missing"
    ON "ai_agent_run" ("organizationId", "startedAt")
    WHERE "needsReview" = true AND "reviewId" IS NULL;

-- Failures, for the incident question.
--
-- "What failed in the last hour" is asked under pressure and scans a table that holds every
-- successful request as well. Partial keeps it proportional to the failures rather than to the
-- traffic.
CREATE INDEX "ai_request_log_failures"
    ON "ai_request_log" ("organizationId", "at")
    WHERE "outcome" <> 'success';

-- One collection per key per tenant.
CREATE UNIQUE INDEX "ai_knowledge_collection_scoped_key"
    ON "ai_knowledge_collection" (COALESCE("organizationId", ''), "key");

-- One document per external id, when it has one.
--
-- Partial on NOT NULL, so the many documents with no external id do not all collide on it. This
-- is what makes re-ingesting a source system idempotent: the second import updates rather than
-- creating a second copy that then answers questions alongside the first.
CREATE UNIQUE INDEX "ai_knowledge_document_external_id"
    ON "ai_knowledge_document" ("collectionId", "externalId")
    WHERE "externalId" IS NOT NULL;
