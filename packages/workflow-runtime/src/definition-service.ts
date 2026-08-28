import { ApiError } from '@trustos/errors';
import type { Authorizer } from '@trustos/authorization';
import type { SecurityEventEmitter } from '@trustos/security-events';
import {
  actorHasPermission,
  crossTenant,
  definitionImmutable,
  WORKFLOW_PERMISSIONS,
  type WorkflowActor,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionStatus,
  type WorkflowVersionRecord,
} from '@trustos/workflow-core';
import {
  assertEditable,
  assertStatusTransition,
  assertValidDefinition,
  compareDefinitions,
  hashDefinition,
  suggestNextVersion,
  validateDefinition,
  type DefinitionComparison,
  type ValidationFinding,
  type WorkflowDefinitionDocument,
} from '@trustos/workflow-definition';
import type { HistoryRecorder } from '@trustos/workflow-history';
import { workflowResource, WORKFLOW_RESOURCE_TYPES } from '@trustos/workflow-policy';

/**
 * The definition lifecycle.
 *
 * draft → under_review → approved → published → retired, and the edges are enforced by
 * `assertStatusTransition` rather than by whichever route happens to be called. Two
 * properties matter more than the states:
 *
 *   * **A published version is immutable.** Every write path checks
 *     `assertEditable` first, and the runtime verifies the stored hash on every
 *     compile. Belt and braces, because the application has write access to its own
 *     database: "the API refuses" is not a guarantee against a direct `UPDATE`.
 *
 *   * **Three different people.** The author cannot approve, and the approver cannot
 *     publish. Enforced by `definitionGovernancePolicy` in the policy layer, so it
 *     applies to every route rather than to this service's methods.
 *
 * The second is the control that stops the whole engine being circumvented: somebody
 * who can author *and* publish can ship a definition with `allowSelfApproval: true` and
 * then approve their own requests through it. Every other control in the system assumes
 * the definition was reviewed by somebody other than its author.
 */

export interface DefinitionStore {
  findByKey(input: {
    organizationId: string;
    key: string;
  }): Promise<WorkflowDefinitionRecord | null>;
  findById(id: string, organizationId: string | null): Promise<WorkflowDefinitionRecord | null>;
  create(
    input: Omit<WorkflowDefinitionRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<WorkflowDefinitionRecord>;
  list(input: {
    organizationId: string;
    includeGlobal?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ items: WorkflowDefinitionRecord[]; total: number }>;
}

export interface DefinitionVersionStore {
  findById(id: string): Promise<WorkflowVersionRecord | null>;
  findByVersion(input: {
    workflowDefinitionId: string;
    version: string;
  }): Promise<WorkflowVersionRecord | null>;
  listForDefinition(workflowDefinitionId: string): Promise<WorkflowVersionRecord[]>;
  findPublished(input: {
    organizationId: string;
    definitionKey: string;
  }): Promise<WorkflowVersionRecord | null>;
  create(
    input: Omit<WorkflowVersionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowVersionRecord>;
  update(input: {
    id: string;
    patch: Partial<WorkflowVersionRecord>;
  }): Promise<WorkflowVersionRecord>;
  /** Instances still running on a version. Checked before retiring. */
  countActiveInstances(versionId: string): Promise<number>;
}

export interface DefinitionServiceOptions {
  definitions: DefinitionStore;
  versions: DefinitionVersionStore;
  history: HistoryRecorder;
  authorizer: Authorizer;
  events?: SecurityEventEmitter;
  /** Permission keys the application defines, for reference validation. */
  knownPermissions?: string[];
  registeredResolvers?: string[];
  registeredCallbacks?: string[];
  registeredCalendars?: string[];
  now?: () => Date;
}

export interface DraftResult {
  definition: WorkflowDefinitionRecord;
  version: WorkflowVersionRecord;
  /** Warnings, which do not block a draft but must be seen before approval. */
  findings: ValidationFinding[];
}

export class WorkflowDefinitionService {
  private readonly now: () => Date;

  constructor(private readonly options: DefinitionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private validateOptions() {
    return {
      ...(this.options.knownPermissions ? { knownPermissions: this.options.knownPermissions } : {}),
      ...(this.options.registeredResolvers
        ? { registeredResolvers: this.options.registeredResolvers }
        : {}),
      ...(this.options.registeredCallbacks
        ? { registeredCallbacks: this.options.registeredCallbacks }
        : {}),
      ...(this.options.registeredCalendars
        ? { registeredCalendars: this.options.registeredCalendars }
        : {}),
    };
  }

  // --- authoring -----------------------------------------------------------

  /**
   * Creates a draft — a new definition, or a new version of an existing one.
   *
   * A draft is validated but **structural errors are refused even here**, before review.
   * Letting an invalid definition sit in draft would waste a reviewer's time on
   * something that could never publish, and the author finds out sooner.
   *
   * Warnings are returned rather than thrown. `allowSelfApproval: true` is a warning: it
   * must be visible in review, and refusing it outright would push a two-person team to
   * work around the engine.
   */
  async createDraft(
    actor: WorkflowActor,
    input: { document: unknown; scope?: 'organization' | 'global' },
  ): Promise<DraftResult> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.DEFINITION_CREATE.key)) {
      throw ApiError.forbidden(
        'Creating a workflow definition requires workflow.definition.create.',
      );
    }

    const result = validateDefinition(input.document, this.validateOptions());
    const document = assertValidDefinition(input.document, this.validateOptions());

    /*
     * A global definition is available to every tenant, so authoring one is a
     * platform-staff act rather than a customer's. Without this check, any
     * organization's author could publish a workflow that every other organization
     * could then start.
     */
    if (input.scope === 'global' && !actor.isSuperAdmin) {
      throw ApiError.forbidden(
        'A global workflow definition is available to every organization, so only platform ' +
          'staff may author one.',
        { reason: 'separation_of_duty', rule: 'global_definition_requires_platform_staff' },
      );
    }

    const organizationId = input.scope === 'global' ? null : actor.organizationId;

    let definition = await this.options.definitions.findByKey({
      organizationId: actor.organizationId,
      key: document.id,
    });

    if (!definition) {
      definition = await this.options.definitions.create({
        organizationId,
        key: document.id,
        name: document.name,
        description: document.description,
        businessObjectType: document.businessObjectType,
        createdById: actor.userId,
      });
    } else {
      // A new version of an existing definition must govern the same thing. Changing
      // the object type is a different workflow wearing the same key, and every
      // instance of the old one would then reference a definition that no longer
      // describes it.
      if (definition.businessObjectType !== document.businessObjectType) {
        throw ApiError.conflict(
          `Workflow "${document.id}" governs "${definition.businessObjectType}". A version that ` +
            `governs "${document.businessObjectType}" is a different workflow — use a new key.`,
          { reason: 'definition_invalid' },
        );
      }
    }

    const existing = await this.options.versions.findByVersion({
      workflowDefinitionId: definition.id,
      version: document.version,
    });

    if (existing) {
      // A published version is immutable; a draft can be replaced by editing it. Either
      // way, creating a second row with the same version number would make "version
      // 1.2.0" ambiguous.
      if (existing.status === 'published' || existing.status === 'retired') {
        throw definitionImmutable(document.version);
      }
      throw ApiError.conflict(
        `Version ${document.version} already exists as a ${existing.status}. Edit it, or use a ` +
          'new version number.',
        { reason: 'definition_invalid', version: document.version, status: existing.status },
      );
    }

    const version = await this.options.versions.create({
      workflowDefinitionId: definition.id,
      organizationId,
      version: document.version,
      status: 'draft',
      definition: document,
      definitionHash: hashDefinition(document),
      initialState: document.initialState,
      finalStates: document.finalStates,
      effectiveFrom: null,
      createdById: actor.userId,
      approvedById: null,
      approvedAt: null,
      publishedById: null,
      publishedAt: null,
      retiredAt: null,
      retiredReason: null,
    });

    await this.record(actor, 'definition.created', definition, version, {
      warnings: result.findings.filter((finding) => finding.severity === 'warning').length,
    });

    return { definition, version, findings: result.findings };
  }

  /**
   * Edits a draft.
   *
   * `assertEditable` refuses anything past `draft`, including `under_review` — a
   * definition under review is one somebody is reading, and letting the author edit it
   * underneath the reviewer means the reviewer approves something other than what they
   * read. Withdrawing to draft first is visible; a silent edit is not.
   */
  async updateDraft(
    actor: WorkflowActor,
    input: { versionId: string; document: unknown },
  ): Promise<DraftResult> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.DEFINITION_UPDATE.key)) {
      throw ApiError.forbidden(
        'Editing a workflow definition requires workflow.definition.update.',
      );
    }

    const version = await this.requireVersion(actor, input.versionId);
    assertEditable({ status: version.status, version: version.version });

    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);

    const result = validateDefinition(input.document, this.validateOptions());
    const document = assertValidDefinition(input.document, this.validateOptions());

    if (document.version !== version.version) {
      throw ApiError.validation(
        [
          {
            path: 'version',
            message:
              `This draft is version ${version.version}. To create ${document.version}, create a ` +
              'new draft — editing the number in place would leave the history claiming a ' +
              'version that never existed.',
          },
        ],
        'The version number cannot be changed by editing.',
      );
    }

    const updated = await this.options.versions.update({
      id: version.id,
      patch: {
        definition: document,
        definitionHash: hashDefinition(document),
        initialState: document.initialState,
        finalStates: document.finalStates,
      },
    });

    await this.record(actor, 'definition.updated', definition, updated, {});

    return { definition, version: updated, findings: result.findings };
  }

  /** Submits a draft for independent review. */
  async submitForApproval(actor: WorkflowActor, versionId: string): Promise<WorkflowVersionRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.DEFINITION_SUBMIT.key)) {
      throw ApiError.forbidden('Submitting a definition requires workflow.definition.submit.');
    }

    const version = await this.requireVersion(actor, versionId);
    assertStatusTransition(version.status, 'under_review');

    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);
    // Re-validated at submission, because the permission catalog may have changed since
    // the draft was written — a permission the definition references may have been
    // renamed, which would make the approver's review of a broken definition.
    assertValidDefinition(version.definition, this.validateOptions());

    const updated = await this.options.versions.update({
      id: version.id,
      patch: { status: 'under_review' },
    });

    await this.record(actor, 'definition.submitted_for_approval', definition, updated, {});
    return updated;
  }

  /** Withdraws a submission, so the author can edit again. */
  async withdraw(actor: WorkflowActor, versionId: string): Promise<WorkflowVersionRecord> {
    const version = await this.requireVersion(actor, versionId);
    assertStatusTransition(version.status, 'draft');

    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);

    const updated = await this.options.versions.update({
      id: version.id,
      // The approval is cleared. A withdrawn-and-reworked version carrying its previous
      // approval would be a definition approved in one form and published in another.
      patch: { status: 'draft', approvedById: null, approvedAt: null },
    });

    await this.record(actor, 'definition.updated', definition, updated, { withdrawn: true });
    return updated;
  }

  // --- governance ----------------------------------------------------------

  /**
   * Approves a version. Cannot be the author.
   *
   * The author check goes through the policy engine rather than an `if` here, so it
   * applies to every route that declares `workflow.definition.approve` — including one
   * written next year by somebody who has not read this file.
   */
  async approve(
    actor: WorkflowActor,
    versionId: string,
    note?: string,
  ): Promise<WorkflowVersionRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.DEFINITION_APPROVE.key)) {
      throw ApiError.forbidden('Approving a definition requires workflow.definition.approve.');
    }

    const version = await this.requireVersion(actor, versionId);
    assertStatusTransition(version.status, 'approved');
    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);

    await this.authorizeGovernance(actor, 'workflow.definition.approve', version);

    const updated = await this.options.versions.update({
      id: version.id,
      patch: {
        status: 'approved',
        approvedById: actor.userId,
        approvedAt: this.now(),
      },
    });

    await this.record(actor, 'definition.approved', definition, updated, {
      note: note ?? null,
      // Recorded on the approval so a reader can see the approver saw them. A warning
      // that was present at approval and is absent later means the definition changed.
      warnings: validateDefinition(version.definition, this.validateOptions())
        .findings.filter((finding) => finding.severity === 'warning')
        .map((finding) => finding.code),
    });

    return updated;
  }

  /**
   * Publishes an approved version.
   *
   * After this the version is immutable and new instances use it. Existing instances are
   * **not** migrated — they keep the version they started on, which is the whole reason
   * versioning exists.
   */
  async publish(
    actor: WorkflowActor,
    versionId: string,
    input: { effectiveFrom?: Date | null; retirePrevious?: boolean } = {},
  ): Promise<{ version: WorkflowVersionRecord; retired: WorkflowVersionRecord | null }> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key)) {
      throw ApiError.forbidden('Publishing a definition requires workflow.definition.publish.');
    }

    const version = await this.requireVersion(actor, versionId);
    assertStatusTransition(version.status, 'published');
    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);

    await this.authorizeGovernance(actor, 'workflow.definition.publish', version);

    // Final validation before immutability. This is the last moment anything can be
    // fixed, so it is the last moment worth checking.
    assertValidDefinition(version.definition, this.validateOptions());

    const previous = definition.organizationId
      ? await this.options.versions.findPublished({
          organizationId: definition.organizationId,
          definitionKey: definition.key,
        })
      : null;

    const published = await this.options.versions.update({
      id: version.id,
      patch: {
        status: 'published',
        publishedById: actor.userId,
        publishedAt: this.now(),
        effectiveFrom: input.effectiveFrom ?? this.now(),
      },
    });

    let retired: WorkflowVersionRecord | null = null;

    /*
     * The previous version is retired by default.
     *
     * Two published versions of one key would make "the published version" ambiguous,
     * and `findPublished` would return whichever the query ordered first. Retiring the
     * old one keeps exactly one active, and its running instances are unaffected —
     * retirement stops *new* instances only.
     */
    if (previous && previous.id !== published.id && input.retirePrevious !== false) {
      retired = await this.options.versions.update({
        id: previous.id,
        patch: {
          status: 'retired',
          retiredAt: this.now(),
          retiredReason: `Superseded by version ${published.version}.`,
        },
      });

      await this.record(actor, 'definition.retired', definition, retired, {
        supersededBy: published.version,
        // Reported, because those instances keep running under the retired version and
        // whoever published needs to know how many there are.
        activeInstances: await this.options.versions.countActiveInstances(previous.id),
      });
    }

    await this.record(actor, 'definition.published', definition, published, {
      effectiveFrom: (input.effectiveFrom ?? this.now()).toISOString(),
      previousVersion: previous?.version ?? null,
    });

    return { version: published, retired };
  }

  /**
   * Retires a published version.
   *
   * New instances stop; running ones continue. Reports how many are still running rather
   * than refusing — an operator retiring a version usually knows there are instances on
   * it, and blocking would mean waiting weeks for the last one to finish.
   */
  async retire(
    actor: WorkflowActor,
    versionId: string,
    reason: string,
  ): Promise<{ version: WorkflowVersionRecord; activeInstances: number }> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.DEFINITION_RETIRE.key)) {
      throw ApiError.forbidden('Retiring a definition requires workflow.definition.retire.');
    }
    if (!reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A retirement reason is required.' }],
        'Say why the version is being retired.',
      );
    }

    const version = await this.requireVersion(actor, versionId);
    assertStatusTransition(version.status, 'retired');
    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);

    const activeInstances = await this.options.versions.countActiveInstances(version.id);

    const retired = await this.options.versions.update({
      id: version.id,
      patch: { status: 'retired', retiredAt: this.now(), retiredReason: reason.trim() },
    });

    await this.record(actor, 'definition.retired', definition, retired, {
      reason: reason.trim(),
      activeInstances,
    });

    return { version: retired, activeInstances };
  }

  /**
   * Rolls back to an earlier version.
   *
   * Republishing a previously approved version, **not** editing history. The old version
   * keeps its original approval and publication record, and a second publication is
   * recorded as its own event — so the trail shows it was live, retired, and made live
   * again, which is what happened.
   */
  async rollbackTo(
    actor: WorkflowActor,
    versionId: string,
    reason: string,
  ): Promise<{ version: WorkflowVersionRecord; retired: WorkflowVersionRecord | null }> {
    const version = await this.requireVersion(actor, versionId);

    // Only a version that was already approved. Rollback is not a way to make an
    // unreviewed definition live in a hurry, which is exactly when somebody would
    // want it to be.
    if (!version.approvedById) {
      throw ApiError.conflict(
        `Version ${version.version} was never approved, so it cannot be rolled back to. ` +
          'Rollback activates a previously approved version; it does not bypass review.',
        { reason: 'definition_not_published' },
      );
    }

    if (version.status === 'published') {
      return { version, retired: null };
    }

    if (version.status !== 'retired' && version.status !== 'approved') {
      throw ApiError.conflict(
        `Version ${version.version} is ${version.status} and cannot be activated.`,
        { reason: 'definition_not_published', status: version.status },
      );
    }

    const definition = await this.requireDefinition(actor, version.workflowDefinitionId);

    await this.authorizeGovernance(actor, 'workflow.definition.publish', version);

    const current = definition.organizationId
      ? await this.options.versions.findPublished({
          organizationId: definition.organizationId,
          definitionKey: definition.key,
        })
      : null;

    let retired: WorkflowVersionRecord | null = null;
    if (current && current.id !== version.id) {
      retired = await this.options.versions.update({
        id: current.id,
        patch: {
          status: 'retired',
          retiredAt: this.now(),
          retiredReason: `Rolled back to version ${version.version}: ${reason}`,
        },
      });
    }

    const republished = await this.options.versions.update({
      id: version.id,
      patch: {
        status: 'published',
        publishedById: actor.userId,
        publishedAt: this.now(),
        retiredAt: null,
        retiredReason: null,
      },
    });

    await this.record(actor, 'definition.published', definition, republished, {
      rollback: true,
      reason,
      rolledBackFrom: current?.version ?? null,
    });

    return { version: republished, retired };
  }

  // --- reads ---------------------------------------------------------------

  async listVersions(actor: WorkflowActor, definitionId: string): Promise<WorkflowVersionRecord[]> {
    await this.requireDefinition(actor, definitionId);
    return this.options.versions.listForDefinition(definitionId);
  }

  /**
   * Compares two versions.
   *
   * What an administrator reads before approving. Organised by consequence rather than
   * by field, with control weakening in its own bucket — see `compareDefinitions`.
   */
  async compare(
    actor: WorkflowActor,
    input: { fromVersionId: string; toVersionId: string },
  ): Promise<{
    comparison: DefinitionComparison;
    suggestedVersion: { version: string; reason: string };
  }> {
    const from = await this.requireVersion(actor, input.fromVersionId);
    const to = await this.requireVersion(actor, input.toVersionId);

    if (from.workflowDefinitionId !== to.workflowDefinitionId) {
      throw ApiError.validation(
        [
          {
            path: 'toVersionId',
            message: 'Two versions of different workflows cannot be compared meaningfully.',
          },
        ],
        'These versions belong to different workflows.',
      );
    }

    const comparison = compareDefinitions(
      from.definition as WorkflowDefinitionDocument,
      to.definition as WorkflowDefinitionDocument,
    );

    return {
      comparison,
      suggestedVersion: suggestNextVersion(from.version, comparison),
    };
  }

  list(
    actor: WorkflowActor,
    input: { page?: number; pageSize?: number } = {},
  ): Promise<{ items: WorkflowDefinitionRecord[]; total: number }> {
    return this.options.definitions.list({
      organizationId: actor.organizationId,
      includeGlobal: true,
      page: input.page ?? 1,
      pageSize: Math.min(Math.max(input.pageSize ?? 25, 1), 100),
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Runs the governance policies.
   *
   * Through the authorizer, so the author-cannot-approve and approver-cannot-publish
   * rules are enforced by the same engine as everything else and produce a decision id
   * that ties the refusal to a security event.
   */
  private async authorizeGovernance(
    actor: WorkflowActor,
    action: string,
    version: WorkflowVersionRecord,
  ): Promise<void> {
    await this.options.authorizer.assert({
      actor: {
        actorType: actor.actorType,
        userId: actor.userId,
        email: actor.email,
        organizationId: actor.organizationId,
        roles: actor.roles,
        permissions: actor.permissions,
        isSuperAdmin: actor.isSuperAdmin,
        tokenId: actor.tokenId,
        authentication: {
          mfa: actor.mfa,
          level: actor.authenticationLevel ?? 'low',
          methods: [],
          acr: null,
          authenticatedAt: null,
        },
      },
      action,
      organizationId: actor.organizationId,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.VERSION,
        id: version.id,
        // A global definition has no organization, so the actor's is used for the
        // tenant policy's benefit. The `isSuperAdmin` check in `createDraft` is what
        // limits who can author one in the first place.
        organizationId: version.organizationId ?? actor.organizationId,
        attributes: {
          authoredById: version.createdById,
          approvedById: version.approvedById,
        },
      }),
    });
  }

  private async requireVersion(actor: WorkflowActor, id: string): Promise<WorkflowVersionRecord> {
    const version = await this.options.versions.findById(id);
    if (!version) throw crossTenant();

    // A global version (null organization) is readable by everyone; an
    // organization-owned one only by its owner. Not found rather than forbidden, so the
    // response does not confirm it exists elsewhere.
    if (version.organizationId && version.organizationId !== actor.organizationId) {
      throw crossTenant();
    }

    return version;
  }

  private async requireDefinition(
    actor: WorkflowActor,
    id: string,
  ): Promise<WorkflowDefinitionRecord> {
    const definition = await this.options.definitions.findById(id, actor.organizationId);
    if (!definition) throw crossTenant();
    return definition;
  }

  private async record(
    actor: WorkflowActor,
    type:
      | 'definition.created'
      | 'definition.updated'
      | 'definition.submitted_for_approval'
      | 'definition.approved'
      | 'definition.published'
      | 'definition.retired',
    definition: WorkflowDefinitionRecord,
    version: WorkflowVersionRecord,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.options.history.record({
      type,
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType,
      workflowDefinitionId: definition.id,
      workflowVersion: version.version,
      metadata: {
        definitionKey: definition.key,
        versionId: version.id,
        status: version.status,
        ...metadata,
      },
    });
  }
}

/** The status a version must be in for each governance step. Rendered by the portal. */
export const DEFINITION_LIFECYCLE: Array<{
  from: WorkflowDefinitionStatus;
  to: WorkflowDefinitionStatus;
  permission: string;
  note: string;
}> = [
  {
    from: 'draft',
    to: 'under_review',
    permission: WORKFLOW_PERMISSIONS.DEFINITION_SUBMIT.key,
    note: 'The author submits. Editing stops here so a reviewer reads a fixed document.',
  },
  {
    from: 'under_review',
    to: 'approved',
    permission: WORKFLOW_PERMISSIONS.DEFINITION_APPROVE.key,
    note: 'Somebody other than the author approves.',
  },
  {
    from: 'approved',
    to: 'published',
    permission: WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key,
    note: 'A third person publishes. The version becomes immutable and new instances use it.',
  },
  {
    from: 'published',
    to: 'retired',
    permission: WORKFLOW_PERMISSIONS.DEFINITION_RETIRE.key,
    note: 'New instances stop. Running instances continue on this version.',
  },
];
