-- Phase 5: governed workflow, maker-checker and case management.
--
-- Twelve tables. The three that carry an integrity guarantee beyond ordinary
-- constraints are called out at the bottom of this file:
--
--   * WorkflowEvent          append-only, enforced by a trigger
--   * WorkflowCommentAmendment  append-only, same
--   * WorkflowEscalation     one escalation per (target, trigger, rule), enforced by
--                            a unique index rather than by a check in code
--
-- Everything above that line is generated from the Prisma schema.

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "businessObjectType" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "workflowDefinitionId" TEXT NOT NULL,
    "organizationId" TEXT,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "initialState" TEXT NOT NULL,
    "finalStates" TEXT[],
    "effectiveFrom" TIMESTAMP(3),
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowDefinitionId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "workflowVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentState" TEXT NOT NULL,
    "businessObjectType" TEXT NOT NULL,
    "businessObjectId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "initiatedById" TEXT NOT NULL,
    "initiatedByActorType" TEXT NOT NULL DEFAULT 'user',
    "version" INTEGER NOT NULL DEFAULT 0,
    "reworkCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "dueAt" TIMESTAMP(3),
    "caseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigneeUserId" TEXT,
    "assigneeRole" TEXT,
    "assigneeGroupId" TEXT,
    "dueAt" TIMESTAMP(3),
    "slaStatus" TEXT,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "delegatedById" TEXT,
    "delegatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "workflowTaskId" TEXT,
    "stepKey" TEXT NOT NULL,
    "approverKey" TEXT,
    "actorId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "actorRole" TEXT,
    "decision" TEXT NOT NULL,
    "reasonCode" TEXT,
    "explanation" TEXT,
    "policyDecisionId" TEXT,
    "reworkCycle" INTEGER NOT NULL DEFAULT 0,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT,
    "caseId" TEXT,
    "workflowTaskId" TEXT,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT,
    "fromState" TEXT,
    "toState" TEXT,
    "action" TEXT,
    "policyDecisionId" TEXT,
    "requestId" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowComment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT,
    "caseId" TEXT,
    "workflowTaskId" TEXT,
    "stepKey" TEXT,
    "authorId" TEXT NOT NULL,
    "authorActorType" TEXT NOT NULL DEFAULT 'user',
    "message" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'participants',
    "amendmentCount" INTEGER NOT NULL DEFAULT 0,
    "redactedAt" TIMESTAMP(3),
    "redactedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowCommentAmendment" (
    "id" TEXT NOT NULL,
    "workflowCommentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "previousMessage" TEXT NOT NULL,
    "amendedById" TEXT NOT NULL,
    "reason" TEXT,
    "amendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowCommentAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT,
    "caseId" TEXT,
    "workflowTaskId" TEXT,
    "stepKey" TEXT,
    "documentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'other',
    "scanStatus" TEXT NOT NULL DEFAULT 'not_scanned',
    "attachedById" TEXT NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "WorkflowAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowSla" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT,
    "workflowTaskId" TEXT,
    "stepKey" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "calendarId" TEXT NOT NULL DEFAULT 'elapsed',
    "durationSeconds" INTEGER NOT NULL,
    "warningAtSeconds" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "warningAt" TIMESTAMP(3) NOT NULL,
    "warnedAt" TIMESTAMP(3),
    "breachedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedSeconds" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowSla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEscalation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowInstanceId" TEXT,
    "workflowTaskId" TEXT,
    "workflowSlaId" TEXT,
    "trigger" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "detail" JSONB,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseType" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "ownerId" TEXT,
    "assignedTeam" TEXT,
    "businessObjectType" TEXT,
    "businessObjectId" TEXT,
    "dueAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolutionCode" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closureReason" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAssignmentCursor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cursorKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowAssignmentCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowDefinition_organizationId_deletedAt_idx" ON "WorkflowDefinition"("organizationId", "deletedAt");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_businessObjectType_idx" ON "WorkflowDefinition"("businessObjectType");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_organizationId_key_key" ON "WorkflowDefinition"("organizationId", "key");

-- CreateIndex
CREATE INDEX "WorkflowVersion_workflowDefinitionId_status_idx" ON "WorkflowVersion"("workflowDefinitionId", "status");

-- CreateIndex
CREATE INDEX "WorkflowVersion_organizationId_status_idx" ON "WorkflowVersion"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowDefinitionId_version_key" ON "WorkflowVersion"("workflowDefinitionId", "version");

-- CreateIndex
CREATE INDEX "WorkflowInstance_organizationId_status_idx" ON "WorkflowInstance"("organizationId", "status");

-- CreateIndex
CREATE INDEX "WorkflowInstance_organizationId_currentState_idx" ON "WorkflowInstance"("organizationId", "currentState");

-- CreateIndex
CREATE INDEX "WorkflowInstance_organizationId_businessObjectType_business_idx" ON "WorkflowInstance"("organizationId", "businessObjectType", "businessObjectId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_organizationId_dueAt_idx" ON "WorkflowInstance"("organizationId", "dueAt");

-- CreateIndex
CREATE INDEX "WorkflowInstance_workflowVersionId_idx" ON "WorkflowInstance"("workflowVersionId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_caseId_idx" ON "WorkflowInstance"("caseId");

-- CreateIndex
CREATE INDEX "WorkflowTask_organizationId_assigneeUserId_status_idx" ON "WorkflowTask"("organizationId", "assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "WorkflowTask_organizationId_assigneeRole_status_idx" ON "WorkflowTask"("organizationId", "assigneeRole", "status");

-- CreateIndex
CREATE INDEX "WorkflowTask_organizationId_assigneeGroupId_status_idx" ON "WorkflowTask"("organizationId", "assigneeGroupId", "status");

-- CreateIndex
CREATE INDEX "WorkflowTask_organizationId_status_dueAt_idx" ON "WorkflowTask"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "WorkflowTask_workflowInstanceId_status_idx" ON "WorkflowTask"("workflowInstanceId", "status");

-- CreateIndex
CREATE INDEX "WorkflowDecision_workflowInstanceId_stepKey_reworkCycle_idx" ON "WorkflowDecision"("workflowInstanceId", "stepKey", "reworkCycle");

-- CreateIndex
CREATE INDEX "WorkflowDecision_organizationId_actorId_idx" ON "WorkflowDecision"("organizationId", "actorId");

-- CreateIndex
CREATE INDEX "WorkflowEvent_workflowInstanceId_sequence_idx" ON "WorkflowEvent"("workflowInstanceId", "sequence");

-- CreateIndex
CREATE INDEX "WorkflowEvent_caseId_occurredAt_idx" ON "WorkflowEvent"("caseId", "occurredAt");

-- CreateIndex
CREATE INDEX "WorkflowEvent_organizationId_occurredAt_idx" ON "WorkflowEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "WorkflowEvent_organizationId_type_occurredAt_idx" ON "WorkflowEvent"("organizationId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEvent_workflowInstanceId_sequence_key" ON "WorkflowEvent"("workflowInstanceId", "sequence");

-- CreateIndex
CREATE INDEX "WorkflowComment_workflowInstanceId_visibility_createdAt_idx" ON "WorkflowComment"("workflowInstanceId", "visibility", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowComment_caseId_visibility_createdAt_idx" ON "WorkflowComment"("caseId", "visibility", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowComment_organizationId_authorId_idx" ON "WorkflowComment"("organizationId", "authorId");

-- CreateIndex
CREATE INDEX "WorkflowCommentAmendment_workflowCommentId_amendedAt_idx" ON "WorkflowCommentAmendment"("workflowCommentId", "amendedAt");

-- CreateIndex
CREATE INDEX "WorkflowAttachment_workflowInstanceId_stepKey_removedAt_idx" ON "WorkflowAttachment"("workflowInstanceId", "stepKey", "removedAt");

-- CreateIndex
CREATE INDEX "WorkflowAttachment_caseId_removedAt_idx" ON "WorkflowAttachment"("caseId", "removedAt");

-- CreateIndex
CREATE INDEX "WorkflowAttachment_organizationId_documentId_idx" ON "WorkflowAttachment"("organizationId", "documentId");

-- CreateIndex
CREATE INDEX "WorkflowSla_status_warningAt_warnedAt_idx" ON "WorkflowSla"("status", "warningAt", "warnedAt");

-- CreateIndex
CREATE INDEX "WorkflowSla_status_dueAt_breachedAt_idx" ON "WorkflowSla"("status", "dueAt", "breachedAt");

-- CreateIndex
CREATE INDEX "WorkflowSla_workflowInstanceId_status_idx" ON "WorkflowSla"("workflowInstanceId", "status");

-- CreateIndex
CREATE INDEX "WorkflowSla_workflowTaskId_idx" ON "WorkflowSla"("workflowTaskId");

-- CreateIndex
CREATE INDEX "WorkflowSla_organizationId_status_idx" ON "WorkflowSla"("organizationId", "status");

-- CreateIndex
CREATE INDEX "WorkflowEscalation_workflowInstanceId_triggeredAt_idx" ON "WorkflowEscalation"("workflowInstanceId", "triggeredAt");

-- CreateIndex
CREATE INDEX "WorkflowEscalation_organizationId_status_triggeredAt_idx" ON "WorkflowEscalation"("organizationId", "status", "triggeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEscalation_organizationId_idempotencyKey_key" ON "WorkflowEscalation"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CaseRecord_organizationId_status_priority_idx" ON "CaseRecord"("organizationId", "status", "priority");

-- CreateIndex
CREATE INDEX "CaseRecord_organizationId_ownerId_status_idx" ON "CaseRecord"("organizationId", "ownerId", "status");

-- CreateIndex
CREATE INDEX "CaseRecord_organizationId_assignedTeam_status_idx" ON "CaseRecord"("organizationId", "assignedTeam", "status");

-- CreateIndex
CREATE INDEX "CaseRecord_organizationId_dueAt_idx" ON "CaseRecord"("organizationId", "dueAt");

-- CreateIndex
CREATE INDEX "CaseRecord_organizationId_businessObjectType_businessObject_idx" ON "CaseRecord"("organizationId", "businessObjectType", "businessObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseRecord_organizationId_reference_key" ON "CaseRecord"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "WorkflowIdempotencyRecord_expiresAt_idx" ON "WorkflowIdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowIdempotencyRecord_organizationId_idempotencyKey_key" ON "WorkflowIdempotencyRecord"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAssignmentCursor_organizationId_cursorKey_key" ON "WorkflowAssignmentCursor"("organizationId", "cursorKey");

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CaseRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTask" ADD CONSTRAINT "WorkflowTask_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDecision" ADD CONSTRAINT "WorkflowDecision_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowCommentAmendment" ADD CONSTRAINT "WorkflowCommentAmendment_workflowCommentId_fkey" FOREIGN KEY ("workflowCommentId") REFERENCES "WorkflowComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAttachment" ADD CONSTRAINT "WorkflowAttachment_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAttachment" ADD CONSTRAINT "WorkflowAttachment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSla" ADD CONSTRAINT "WorkflowSla_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEscalation" ADD CONSTRAINT "WorkflowEscalation_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Append-only history
-- ===========================================================================
--
-- Same reasoning as the AuditLog trigger in 20260729010000, and worth restating
-- because the alternative looks correct:
--
--   REVOKE UPDATE, DELETE ON "WorkflowEvent" FROM trustos_app;
--
-- PostgreSQL grants a table's owner implicit rights on it, so when the
-- application connects as the owner — the default on Railway and on most
-- single-role deployments — the REVOKE succeeds and changes nothing. A BEFORE
-- trigger applies to the owner too.
--
-- Workflow history matters more here than in most places. It is the record of
-- who approved what, and the first thing anybody would want to change after
-- making a decision they should not have. `WorkflowDecision` rows are referenced
-- by history entries and are themselves never updated by the application; the
-- trigger covers the trail that ties them together.
--
-- What this does not protect against: a superuser can drop the trigger. It is a
-- control against application bugs, a compromised application role, and
-- well-meaning manual edits — not against a compromised database administrator.

CREATE OR REPLACE FUNCTION trustos_workflow_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Workflow history is append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflowevent_append_only ON "WorkflowEvent";

CREATE TRIGGER workflowevent_append_only
  BEFORE UPDATE OR DELETE ON "WorkflowEvent"
  FOR EACH ROW
  EXECUTE FUNCTION trustos_workflow_history_append_only();

-- A comment's amendment record is the evidence that the comment changed. Editing
-- it would defeat the whole mechanism: the point of writing the previous text is
-- that the previous text cannot then be rewritten.
DROP TRIGGER IF EXISTS workflowcommentamendment_append_only ON "WorkflowCommentAmendment";

CREATE TRIGGER workflowcommentamendment_append_only
  BEFORE UPDATE OR DELETE ON "WorkflowCommentAmendment"
  FOR EACH ROW
  EXECUTE FUNCTION trustos_workflow_history_append_only();

-- A decision is a signature. It is written once and never amended; a reviewer who
-- changes their mind records a new decision, which is what the trail should show.
DROP TRIGGER IF EXISTS workflowdecision_append_only ON "WorkflowDecision";

CREATE TRIGGER workflowdecision_append_only
  BEFORE UPDATE OR DELETE ON "WorkflowDecision"
  FOR EACH ROW
  EXECUTE FUNCTION trustos_workflow_history_append_only();

-- ===========================================================================
-- Published-version immutability
-- ===========================================================================
--
-- The application refuses to edit a published version, and the runtime verifies
-- the recorded hash on every compile. This is the third layer: the database
-- refuses to change the *definition document* of a published or retired version,
-- whatever the application intends.
--
-- Status and retirement fields stay mutable, because retiring a version is a
-- legitimate update to a published row. What cannot change is the document, its
-- hash, its version number, its initial state and its final states — the things a
-- running instance reads its rules from.

CREATE OR REPLACE FUNCTION trustos_workflow_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('published', 'retired') THEN
    IF NEW."definition"::text IS DISTINCT FROM OLD."definition"::text
       OR NEW."definitionHash" IS DISTINCT FROM OLD."definitionHash"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."initialState" IS DISTINCT FROM OLD."initialState"
       OR NEW."finalStates" IS DISTINCT FROM OLD."finalStates"
       OR NEW."workflowDefinitionId" IS DISTINCT FROM OLD."workflowDefinitionId"
    THEN
      RAISE EXCEPTION
        'Workflow version % is % and its definition is immutable. Create a new version.',
        OLD."version", OLD."status"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflowversion_immutable ON "WorkflowVersion";

CREATE TRIGGER workflowversion_immutable
  BEFORE UPDATE ON "WorkflowVersion"
  FOR EACH ROW
  EXECUTE FUNCTION trustos_workflow_version_immutable();

-- A published version must never be deleted: an instance reads its rules from it,
-- and a deleted version turns every running instance into a record that cannot be
-- explained. Retirement is the supported way to take a version out of service.
CREATE OR REPLACE FUNCTION trustos_workflow_version_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('published', 'retired') THEN
    RAISE EXCEPTION
      'Workflow version % is % and cannot be deleted. Instances read their rules from it.',
      OLD."version", OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflowversion_no_delete ON "WorkflowVersion";

CREATE TRIGGER workflowversion_no_delete
  BEFORE DELETE ON "WorkflowVersion"
  FOR EACH ROW
  EXECUTE FUNCTION trustos_workflow_version_no_delete();
