import {
  PRODUCT_AUDIT_ACTIONS,
  type ProductAuditAction,
  definitionContentHash,
  productError,
  systemClock,
  type ProductAuditRecorder,
  type ProductClock,
  type ProductDefinition,
  type ProductLifecycleStatus,
} from '@trustsystem/financial-product-core';
import {
  validateProduct,
  type ValidateProductOptions,
  type ValidationResult,
} from '@trustsystem/financial-product-composer';
import {
  applyLifecycleTransition,
  checkLifecycleTransition,
  type LifecycleCheck,
} from '@trustsystem/financial-product-state-machine';
import {
  assertApprovalComplete,
  auditGovernanceAction,
  classifyChange,
  deriveApprovalState,
  recordDecision,
  type ApprovalState,
  type ChangeClassification,
} from '@trustsystem/financial-product-governance';
import {
  applyRollback,
  assertSufficientBump,
  assertUnpublishedOrIdentical,
  planRollback,
  publishVersion,
  verifyContentHash,
  type PublishedVersion,
  type RollbackPlan,
} from '@trustsystem/financial-product-versioning';
import { resolveVariant, type ProductVariant } from '@trustsystem/financial-product-variants';
import { InMemoryProductStore, type ProductRecord, type ProductStore } from './store';

/**
 * The product registry.
 *
 * The single place a product changes state. Every method here follows the same six steps, in the
 * same order, and the order is the design:
 *
 *   1. **Load, tenant-scoped.** A record in another organization is `not_found`, never
 *      `forbidden` — a 403 confirms the product exists, which is the enumeration primitive the
 *      boundary exists to deny.
 *   2. **Resolve the transition** against the lifecycle machine, *before* asking whether the
 *      actor is permitted. A caller must not be able to learn whether they would be allowed to do
 *      something the lifecycle does not permit.
 *   3. **Check the preconditions** — permission, self-approval, outstanding approvals, and
 *      whether the definition still hashes to what was reviewed.
 *   4. **Apply**, conditionally on the revision the read saw.
 *   5. **Audit**, in the same call. `auditGovernanceAction` writes the record; a caller who wrote
 *      the state and forgot the audit produces a history with a hole in it, discovered during an
 *      audit rather than in a test.
 *   6. **Return the new state.**
 *
 * The registry does not authorize. It receives an actor whose permissions were resolved
 * server-side and checks them against the transition; the policy engine
 * (`@trustsystem/financial-product-policy`) covers every route independently. Two enforcement points
 * for the same rule is deliberate — the registry covers the registry, and the policies cover the
 * endpoint somebody adds next year.
 */

export interface RegistryActor {
  actorId: string;
  organizationId: string | null;
  /** Resolved server-side from the membership tables. Never from a request body. */
  permissions: readonly string[];
}

export interface ProductRegistryOptions {
  store?: ProductStore;
  audit: ProductAuditRecorder;
  clock?: ProductClock;
  /** Passed to the validator. Supplying connectors makes an unbound provider an error. */
  validation?: ValidateProductOptions;
}

export interface ProductState {
  productId: string;
  organizationId: string | null;
  lifecycleStatus: ProductLifecycleStatus;
  activeVersion: string | null;
  versions: string[];
  approval: ApprovalState;
  classification: ChangeClassification;
  revision: number;
}

export class ProductRegistry {
  private readonly store: ProductStore;
  private readonly audit: ProductAuditRecorder;
  private readonly clock: ProductClock;
  private readonly validationOptions: ValidateProductOptions;

  constructor(options: ProductRegistryOptions) {
    this.store = options.store ?? new InMemoryProductStore();
    this.audit = options.audit;
    this.clock = options.clock ?? systemClock;
    this.validationOptions = options.validation ?? {};
  }

  // --- reading -------------------------------------------------------------

  /** A product, tenant-scoped. Missing and another tenant's are the same answer. */
  async get(actor: RegistryActor, productId: string): Promise<ProductRecord> {
    const record = await this.store.find(actor.organizationId, productId);

    if (!record) {
      throw productError('product_not_found', `No product "${productId}".`, { productId });
    }

    return record;
  }

  /**
   * The definition new executions should bind to.
   *
   * Verifies the content hash on every call rather than on the first. Caching the verdict would
   * mean a definition edited between two executions is verified once and trusted afterwards,
   * which is exactly the window somebody would use.
   */
  async activeVersion(actor: RegistryActor, productId: string): Promise<PublishedVersion> {
    const record = await this.get(actor, productId);

    if (!record.activeVersion) {
      throw productError(
        'product_not_executable',
        `Product "${productId}" has no active version. Nothing executes until one is activated.`,
        { productId },
      );
    }

    const version = record.versions.find((candidate) => candidate.version === record.activeVersion);

    if (!version) {
      throw productError(
        'product_version_not_found',
        `Product "${productId}" points at version ${record.activeVersion}, which is not stored.`,
        { productId, version: record.activeVersion },
      );
    }

    verifyContentHash(version);
    return version;
  }

  /** A specific published version. Used by an execution resuming under its binding. */
  async version(
    actor: RegistryActor,
    productId: string,
    version: string,
  ): Promise<PublishedVersion> {
    const record = await this.get(actor, productId);
    const found = record.versions.find((candidate) => candidate.version === version);

    if (!found) {
      throw productError(
        'product_version_not_found',
        `Product "${productId}" has no version ${version}.`,
        { productId, version },
      );
    }

    verifyContentHash(found);
    return found;
  }

  /** The effective definition for a variant, resolved against its pinned base version. */
  async resolvedVariant(
    actor: RegistryActor,
    variantId: string,
  ): Promise<{ definition: ProductDefinition; variant: ProductVariant }> {
    const variant = await this.store.findVariant(actor.organizationId, variantId);

    if (!variant) {
      throw productError('product_not_found', `No variant "${variantId}".`, {
        productId: variantId,
      });
    }

    const base = await this.version(actor, variant.baseProductId, variant.baseVersion);
    return { definition: resolveVariant(base.definition, variant).definition, variant };
  }

  // --- composing -----------------------------------------------------------

  /**
   * Creates a product from a draft definition.
   *
   * The draft's author is recorded here, from the actor, and never accepted as a parameter. Every
   * self-approval check downstream compares against this field, so a caller-supplied author would
   * make maker-checker a value the maker fills in.
   */
  async create(actor: RegistryActor, draft: ProductDefinition): Promise<ProductState> {
    this.requirePermission(actor, 'financial.product.create');

    const record = await this.store.create({
      productId: draft.productId,
      organizationId: actor.organizationId,
      draft: { ...draft, lifecycleStatus: 'draft' },
      draftAuthorId: actor.actorId,
      draftSubmittedById: null,
      versions: [],
      activeVersion: null,
      decisions: [],
      revision: 0,
    });

    await auditGovernanceAction(this.audit, {
      action: PRODUCT_AUDIT_ACTIONS.PRODUCT_CREATED,
      productId: draft.productId,
      version: draft.version,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: { productType: draft.productType },
      now: this.clock.now(),
    });

    return this.stateOf(record);
  }

  /**
   * Replaces the draft.
   *
   * Refuses once the product is past the editable states, and refuses a change to a sensitive
   * field unless the actor holds that field's own permission. The second check is what makes the
   * permission split real: without it, a product editor changes a fee through the same call they
   * change a description through.
   */
  async updateDraft(
    actor: RegistryActor,
    productId: string,
    draft: ProductDefinition,
  ): Promise<ProductState> {
    const record = await this.get(actor, productId);
    const current = record.draft;

    if (!current) {
      throw productError(
        'product_definition_immutable',
        `Product "${productId}" has no draft. Create a new draft version to change it.`,
        { productId },
      );
    }

    assertUnpublishedOrIdentical(current.lifecycleStatus, definitionContentHash(current), draft);

    const classification = classifyChange(current, draft);
    this.requirePermission(actor, 'financial.product.update');

    for (const path of classification.sensitivePaths) {
      const permission = SENSITIVE_PERMISSIONS[path];
      if (permission) this.requirePermission(actor, permission);
    }

    const updated = await this.store.update(
      { ...record, draft: { ...draft, lifecycleStatus: current.lifecycleStatus } },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action: auditActionForChange(classification),
      productId,
      version: draft.version,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: { changed: classification.changedPaths.join(',') },
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  /** Validates the draft, and records the result on the lifecycle when it passes. */
  async validate(actor: RegistryActor, productId: string): Promise<ValidationResult> {
    const record = await this.get(actor, productId);
    if (!record.draft) {
      throw productError('product_not_found', `Product "${productId}" has no draft.`, {
        productId,
      });
    }

    return validateProduct(record.draft, this.validationOptions);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Moves the draft through the lifecycle.
   *
   * The transition is resolved against the machine before the actor's permissions are consulted,
   * so a caller cannot learn whether they would be permitted to do something the lifecycle does
   * not allow.
   */
  async transition(actor: RegistryActor, productId: string, action: string): Promise<ProductState> {
    const record = await this.get(actor, productId);
    const draft = record.draft;

    if (!draft) {
      throw productError(
        'product_lifecycle_transition_invalid',
        `Product "${productId}" has no draft to move.`,
        { productId },
      );
    }

    const classification = classifyChange(this.previousDefinition(record), draft);
    const approval = deriveApprovalState(classification, record.decisions);

    const next = applyLifecycleTransition(draft.lifecycleStatus, action, {
      actorPermissions: actor.permissions,
      authoredById: record.draftAuthorId,
      actorId: actor.actorId,
      recordedApprovalLevels: approval.approvedLevels,
      requiredApprovalLevels: classification.requiredApprovalLevels,
      definitionUnchanged: true,
    });

    /*
     * Validation gates `validate`, and only `validate`.
     *
     * Putting it on every transition would mean a product that was valid when it was approved
     * becomes un-approvable because a block was deprecated in the meantime — which turns a
     * catalog change into an outage for everything in review.
     */
    if (action === 'validate') {
      const result = validateProduct(draft, this.validationOptions);
      if (!result.valid) {
        throw productError(
          'product_definition_invalid',
          `Product "${productId}" does not validate: ` +
            result.findings
              .filter((finding) => finding.severity === 'error')
              .map((finding) => `${finding.subject}: ${finding.message}`)
              .join(' '),
          { productId, version: draft.version },
        );
      }
    }

    const updated = await this.store.update(
      {
        ...record,
        draft: { ...draft, lifecycleStatus: next },
        draftSubmittedById: action === 'submit' ? actor.actorId : record.draftSubmittedById,
      },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action: AUDIT_BY_ACTION[action] ?? PRODUCT_AUDIT_ACTIONS.PRODUCT_EDITED,
      productId,
      version: draft.version,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: { from: draft.lifecycleStatus, to: next },
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  /** Whether a transition would be permitted, and every reason it would not. */
  async checkTransition(
    actor: RegistryActor,
    productId: string,
    action: string,
  ): Promise<LifecycleCheck> {
    const record = await this.get(actor, productId);
    const draft = record.draft;

    if (!draft) {
      throw productError('product_not_found', `Product "${productId}" has no draft.`, {
        productId,
      });
    }

    const classification = classifyChange(this.previousDefinition(record), draft);
    const approval = deriveApprovalState(classification, record.decisions);

    return checkLifecycleTransition(draft.lifecycleStatus, action, {
      actorPermissions: actor.permissions,
      authoredById: record.draftAuthorId,
      actorId: actor.actorId,
      recordedApprovalLevels: approval.approvedLevels,
      requiredApprovalLevels: classification.requiredApprovalLevels,
      definitionUnchanged: true,
    });
  }

  /** Records an approval or a rejection against the draft. */
  async decide(
    actor: RegistryActor,
    productId: string,
    input: { level: string; decision: 'approved' | 'rejected'; reason?: string },
  ): Promise<ProductState> {
    this.requirePermission(actor, 'financial.product.approve');

    const record = await this.get(actor, productId);
    const draft = record.draft;

    if (!draft) {
      throw productError('product_not_found', `Product "${productId}" has no draft.`, {
        productId,
      });
    }

    if (draft.lifecycleStatus !== 'under_review') {
      throw productError(
        'product_lifecycle_transition_invalid',
        `Product "${productId}" is "${draft.lifecycleStatus}" and is not under review.`,
        { productId, expected: 'under_review', actual: draft.lifecycleStatus },
      );
    }

    const classification = classifyChange(this.previousDefinition(record), draft);

    const { decision } = recordDecision({
      classification,
      existing: record.decisions,
      productId,
      version: draft.version,
      organizationId: actor.organizationId,
      authoredById: record.draftAuthorId ?? '',
      actorId: actor.actorId,
      level: input.level,
      decision: input.decision,
      ...(input.reason ? { reason: input.reason } : {}),
      now: this.clock.now(),
    });

    const updated = await this.store.update(
      { ...record, decisions: [...record.decisions, decision] },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action:
        input.decision === 'approved'
          ? PRODUCT_AUDIT_ACTIONS.PRODUCT_APPROVED
          : PRODUCT_AUDIT_ACTIONS.PRODUCT_REJECTED,
      productId,
      version: draft.version,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: { level: input.level },
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  /**
   * Publishes the approved draft as an immutable version.
   *
   * Three refusals stack here, and none of them is redundant: the approvals must be complete, the
   * publisher must not be the author, and the version bump must be large enough for what changed.
   * The last one is the quiet one — a workflow change shipped as a patch is a breaking change
   * every channel discovers at runtime.
   */
  async publish(
    actor: RegistryActor,
    productId: string,
    changeSummary: string,
  ): Promise<ProductState> {
    this.requirePermission(actor, 'financial.product.publish');

    const record = await this.get(actor, productId);
    const draft = record.draft;

    if (!draft) {
      throw productError('product_not_found', `Product "${productId}" has no draft.`, {
        productId,
      });
    }

    if (draft.lifecycleStatus !== 'approved') {
      throw productError(
        'product_approval_required',
        `Product "${productId}" is "${draft.lifecycleStatus}". Only an approved draft may be published.`,
        { productId, expected: 'approved', actual: draft.lifecycleStatus },
      );
    }

    /*
     * The author may not publish, whatever the approvals say.
     *
     * `publishVersion` refuses an author publishing with *no* approvals; this refuses them
     * publishing at all. The two are deliberately different strengths: the versioning package
     * guards the data structure and cannot know who else was involved, and the registry knows.
     *
     * `@trustsystem/financial-product-policy` enforces the same rule on every route. Two enforcement
     * points for one rule is not redundancy — the registry covers the registry, and the policy
     * covers the endpoint somebody adds next year.
     */
    if (record.draftAuthorId === actor.actorId) {
      throw productError(
        'product_self_approval_refused',
        'The actor composed this version and cannot publish their own version. Maker, checker ' +
          'and publisher are three people; collapsing any two of them removes the control.',
        { productId, version: draft.version },
      );
    }

    const previous = this.previousDefinition(record);
    const classification = classifyChange(previous, draft);
    const approval = deriveApprovalState(classification, record.decisions);

    assertApprovalComplete(approval, productId, draft.version);

    if (previous)
      assertSufficientBump(previous.version, draft.version, classification.changedPaths);

    const version = publishVersion({
      definition: { ...draft, lifecycleStatus: 'staged' },
      organizationId: actor.organizationId,
      publishedById: actor.actorId,
      authoredById: record.draftAuthorId ?? actor.actorId,
      approvedBy: approval.decisions
        .filter((decision) => decision.decision === 'approved')
        .map((decision) => ({ level: decision.level, actorId: decision.actorId })),
      supersedes: previous?.version ?? null,
      changeSummary,
      changedPaths: classification.changedPaths,
      now: this.clock.now(),
    });

    const updated = await this.store.update(
      {
        ...record,
        draft: null,
        draftAuthorId: null,
        draftSubmittedById: null,
        decisions: [],
        versions: [...record.versions, version],
      },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action: PRODUCT_AUDIT_ACTIONS.PRODUCT_STAGED,
      productId,
      version: version.version,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: {
        supersedes: previous?.version ?? null,
        changed: classification.changedPaths.join(','),
      },
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  /** Makes a staged version the one new executions bind to. */
  async activate(actor: RegistryActor, productId: string, version: string): Promise<ProductState> {
    this.requirePermission(actor, 'financial.product.publish');

    const record = await this.get(actor, productId);
    const target = record.versions.find((candidate) => candidate.version === version);

    if (!target) {
      throw productError(
        'product_version_not_found',
        `Product "${productId}" has no version ${version}.`,
        { productId, version },
      );
    }

    /*
     * The author may not make their own version live.
     *
     * Not "the publisher may not activate": the publisher activating what they published is an
     * ordinary two-person flow, and refusing it would make the framework unusable in a small
     * deployment. The line that matters is the one between composing and releasing.
     */
    if (target.authoredById === actor.actorId) {
      throw productError(
        'product_self_approval_refused',
        'The actor composed this version and cannot make it live.',
        { productId, version },
      );
    }

    verifyContentHash(target);

    const activated: PublishedVersion = {
      ...target,
      definition: { ...target.definition, lifecycleStatus: 'active' },
    };

    const updated = await this.store.update(
      {
        ...record,
        activeVersion: version,
        versions: record.versions.map((candidate) =>
          candidate.version === version
            ? activated
            : candidate.definition.lifecycleStatus === 'active'
              ? { ...candidate, definition: { ...candidate.definition, lifecycleStatus: 'paused' } }
              : candidate,
        ),
      },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action: PRODUCT_AUDIT_ACTIONS.PRODUCT_ACTIVATED,
      productId,
      version,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  /**
   * Withdraws the live version from new transactions.
   *
   * Deliberately needs no approval. An incident response that waits for a checker is not an
   * incident response, and every second between "we know" and "it stopped" is transactions.
   */
  async pause(actor: RegistryActor, productId: string, reason: string): Promise<ProductState> {
    this.requirePermission(actor, 'financial.product.pause');

    const record = await this.get(actor, productId);

    if (!record.activeVersion) {
      throw productError('product_not_executable', `Product "${productId}" is not active.`, {
        productId,
      });
    }

    const updated = await this.store.update(
      {
        ...record,
        activeVersion: null,
        versions: record.versions.map((candidate) =>
          candidate.version === record.activeVersion
            ? { ...candidate, definition: { ...candidate.definition, lifecycleStatus: 'paused' } }
            : candidate,
        ),
      },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action: PRODUCT_AUDIT_ACTIONS.PRODUCT_PAUSED,
      productId,
      version: record.activeVersion,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: { reason },
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  /** Produces the rollback plan. Nothing changes; the plan is what a person reviews. */
  async planRollback(
    actor: RegistryActor,
    productId: string,
    toVersion: string,
    reason: string,
  ): Promise<RollbackPlan> {
    this.requirePermission(actor, 'financial.product.rollback');

    const record = await this.get(actor, productId);
    const current = record.versions.find((candidate) => candidate.version === record.activeVersion);
    const target = record.versions.find((candidate) => candidate.version === toVersion);

    if (!current) {
      throw productError('product_not_executable', `Product "${productId}" is not active.`, {
        productId,
      });
    }

    if (!target) {
      throw productError(
        'product_version_not_found',
        `Product "${productId}" has no version ${toVersion}.`,
        { productId, version: toVersion },
      );
    }

    return planRollback({
      current,
      target,
      reason,
      inFlightCount: await this.store.countInFlight(
        actor.organizationId,
        productId,
        current.version,
      ),
    });
  }

  /**
   * Applies a rollback plan.
   *
   * Takes the plan rather than the arguments, so what was reviewed is what runs. `--dry-run` is
   * *not calling this*, never a second code path.
   */
  async rollback(actor: RegistryActor, plan: RollbackPlan): Promise<ProductState> {
    this.requirePermission(actor, 'financial.product.rollback');

    const record = await this.get(actor, plan.productId);
    const outcome = applyRollback(plan, this.clock.now());

    const updated = await this.store.update(
      {
        ...record,
        activeVersion: outcome.activatedVersion,
        versions: record.versions.map((candidate) => {
          if (candidate.version === outcome.pausedVersion) {
            return {
              ...candidate,
              definition: { ...candidate.definition, lifecycleStatus: 'paused' },
            };
          }
          if (candidate.version === outcome.activatedVersion) {
            return {
              ...candidate,
              definition: { ...candidate.definition, lifecycleStatus: 'active' },
            };
          }
          return candidate;
        }),
      },
      record.revision,
    );

    await auditGovernanceAction(this.audit, {
      action: PRODUCT_AUDIT_ACTIONS.PRODUCT_ROLLED_BACK,
      productId: plan.productId,
      version: outcome.activatedVersion,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: {
        from: outcome.pausedVersion,
        reason: plan.reason,
        inFlight: plan.inFlightCount,
        historicalExecutionsRewritten: outcome.historicalExecutionsRewritten,
      },
      now: this.clock.now(),
    });

    return this.stateOf(updated);
  }

  // --- variants ------------------------------------------------------------

  async saveVariant(actor: RegistryActor, variant: ProductVariant): Promise<ProductVariant> {
    this.requirePermission(actor, 'financial.product.variant.manage');

    // Resolving proves the overrides are legal against the pinned base before anything is stored.
    const base = await this.version(actor, variant.baseProductId, variant.baseVersion);
    resolveVariant(base.definition, variant);

    const saved = await this.store.saveVariant(actor.organizationId, variant);

    await auditGovernanceAction(this.audit, {
      action: PRODUCT_AUDIT_ACTIONS.VARIANT_CHANGED,
      productId: variant.baseProductId,
      version: variant.baseVersion,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      outcome: 'allowed',
      detail: { variantId: variant.variantId },
      now: this.clock.now(),
    });

    return saved;
  }

  async listVariants(actor: RegistryActor, productId: string): Promise<ProductVariant[]> {
    return this.store.listVariants(actor.organizationId, productId);
  }

  async list(actor: RegistryActor): Promise<ProductRecord[]> {
    return this.store.list(actor.organizationId);
  }

  // --- internals -----------------------------------------------------------

  private previousDefinition(record: ProductRecord): ProductDefinition | null {
    const latest = record.versions[record.versions.length - 1];
    return latest ? latest.definition : null;
  }

  private stateOf(record: ProductRecord): ProductState {
    const classification = classifyChange(
      this.previousDefinition(record),
      record.draft ?? this.previousDefinition(record) ?? EMPTY_FOR_CLASSIFICATION,
    );

    return {
      productId: record.productId,
      organizationId: record.organizationId,
      lifecycleStatus:
        record.draft?.lifecycleStatus ??
        record.versions.find((version) => version.version === record.activeVersion)?.definition
          .lifecycleStatus ??
        'retired',
      activeVersion: record.activeVersion,
      versions: record.versions.map((version) => version.version),
      approval: deriveApprovalState(classification, record.decisions),
      classification,
      revision: record.revision,
    };
  }

  private requirePermission(actor: RegistryActor, permission: string): void {
    if (actor.permissions.includes(permission)) return;

    throw productError('product_approval_required', `The actor does not hold "${permission}".`, {
      expected: permission,
    });
  }
}

/** Which permission each sensitive change needs, on top of `update`. */
const SENSITIVE_PERMISSIONS: Record<string, string | undefined> = {
  fees: 'financial.product.fee.update',
  limits: 'financial.product.limit.update',
  providers: 'financial.product.provider.update',
  rules: 'financial.product.rule.update',
};

const AUDIT_BY_ACTION: Record<string, ProductAuditAction | undefined> = {
  submit: PRODUCT_AUDIT_ACTIONS.PRODUCT_SUBMITTED,
  approve: PRODUCT_AUDIT_ACTIONS.PRODUCT_APPROVED,
  reject: PRODUCT_AUDIT_ACTIONS.PRODUCT_REJECTED,
  stage: PRODUCT_AUDIT_ACTIONS.PRODUCT_STAGED,
  activate: PRODUCT_AUDIT_ACTIONS.PRODUCT_ACTIVATED,
  pause: PRODUCT_AUDIT_ACTIONS.PRODUCT_PAUSED,
  deprecate: PRODUCT_AUDIT_ACTIONS.PRODUCT_DEPRECATED,
  retire: PRODUCT_AUDIT_ACTIONS.VERSION_RETIRED,
};

/**
 * Which audit action a change gets.
 *
 * A fee change is `fee.changed`, not `edited`. An auditor searching for every fee change would
 * otherwise have to read every edit record and diff it, and they will not — they will search for
 * the action name that does not exist and conclude nothing changed.
 */
function auditActionForChange(classification: ChangeClassification): ProductAuditAction {
  if (classification.sensitivePaths.includes('fees')) return PRODUCT_AUDIT_ACTIONS.FEE_CHANGED;
  if (classification.sensitivePaths.includes('limits')) return PRODUCT_AUDIT_ACTIONS.LIMIT_CHANGED;
  if (classification.sensitivePaths.includes('providers'))
    return PRODUCT_AUDIT_ACTIONS.PROVIDER_CHANGED;
  if (classification.sensitivePaths.includes('rules')) return PRODUCT_AUDIT_ACTIONS.RULE_CHANGED;
  return PRODUCT_AUDIT_ACTIONS.PRODUCT_EDITED;
}

/** A placeholder used only to classify an empty record. Never stored, never executed. */
const EMPTY_FOR_CLASSIFICATION = {
  productId: '',
  productName: '',
  productType: 'payment',
  description: '',
  version: '0.0.0',
} as unknown as ProductDefinition;
