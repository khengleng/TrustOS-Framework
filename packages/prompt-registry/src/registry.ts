import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { LoggerPort } from '@trustsystem/logging';
import { message, type Message } from '@trustsystem/ai-sdk';
import { z } from 'zod';
import {
  promptVariableSchema,
  referencedComponents,
  referencedVariables,
  renderTemplate,
  validateTemplateSyntax,
  type PromptVariable,
  type VariableValue,
} from './template';

/**
 * The prompt registry.
 *
 * The same shape as phase 5's workflow definitions, and for the same reason: **a published
 * version never changes.**
 *
 * A prompt is not a string in a source file. It is a thing that gets reviewed, approved, measured
 * and occasionally rolled back, and every one of those needs a version that cannot move under it.
 * Concretely: an evaluation run scores version 3. Somebody edits version 3. The score now
 * describes a prompt that no longer exists, and there is no way to discover that — which makes
 * the entire evaluation record worthless.
 *
 * So editing is confined to drafts, publication is a transition, and a change is a new version.
 */

export const PROMPT_STATUSES = ['draft', 'in_review', 'approved', 'published', 'retired'] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

export const promptVersionSchema = z
  .object({
    id: z.string(),
    /** Stable across versions. What an application asks for. */
    promptKey: z
      .string()
      .min(1)
      .max(120)
      .regex(
        /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/,
        'A prompt key is lowercase and dot-separated.',
      ),
    version: z.number().int().min(1),
    organizationId: z.string().nullable(),

    description: z.string().min(1).max(1000),
    /** Who is accountable for it. Not who typed it. */
    owner: z.string().min(1).max(200),

    /** The system message. Optional — some prompts are a user turn only. */
    system: z.string().max(100_000).nullable().default(null),
    /** The user-turn template. */
    template: z.string().min(1).max(100_000),

    variables: z.array(promptVariableSchema).max(50).default([]),

    /** JSON Schema the output must match, when the prompt asks for structure. */
    outputSchema: z.record(z.unknown()).nullable().default(null),

    /** The guardrail profile to apply. Resolved by `@trustsystem/guardrails`. */
    safetyPolicy: z.string().max(120).nullable().default(null),

    /** Suggested defaults. A caller may override; the model is chosen by the router. */
    temperature: z.number().min(0).max(2).nullable().default(null),
    maxOutputTokens: z.number().int().min(1).max(200_000).nullable().default(null),

    /** Reusable fragments this prompt includes. */
    components: z.record(z.string().max(50_000)).default({}),
    /** Locale key to a replacement template. */
    localizedTemplates: z.record(z.string().max(100_000)).default({}),

    status: z.enum(PROMPT_STATUSES).default('draft'),

    /**
     * SHA-256 of the content, computed at publication.
     *
     * Checked on every render. Immutability is enforced by the service and, in a real deployment,
     * by a database trigger; this is the third layer, and it is the one that catches a direct
     * `UPDATE` against the table — which the application's own credentials can perform.
     */
    contentHash: z.string().nullable().default(null),

    effectiveFrom: z.coerce.date().nullable().default(null),
    retiredAt: z.coerce.date().nullable().default(null),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable(),
    approvedAt: z.coerce.date().nullable().default(null),
    approvedById: z.string().nullable().default(null),
    publishedAt: z.coerce.date().nullable().default(null),
    publishedById: z.string().nullable().default(null),
  })
  .strict();

export type PromptVersion = z.infer<typeof promptVersionSchema>;

export interface PromptStore {
  create(version: PromptVersion): Promise<PromptVersion>;
  findById(id: string, organizationId: string | null): Promise<PromptVersion | null>;
  findVersion(
    promptKey: string,
    version: number,
    organizationId: string | null,
  ): Promise<PromptVersion | null>;
  /** The published version, or null. */
  findPublished(promptKey: string, organizationId: string | null): Promise<PromptVersion | null>;
  listVersions(promptKey: string, organizationId: string | null): Promise<PromptVersion[]>;
  listKeys(organizationId: string | null): Promise<string[]>;
  update(id: string, patch: Partial<PromptVersion>): Promise<PromptVersion | null>;
  /** Applies only if the row is currently in one of `from`. Makes publication race-safe. */
  transition(
    id: string,
    from: PromptStatus[],
    patch: Partial<PromptVersion> & { status: PromptStatus },
  ): Promise<boolean>;
}

export interface PromptRegistryOptions {
  store: PromptStore;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

/** What a render produced, ready for the gateway. */
export interface RenderedPrompt {
  promptKey: string;
  version: number;
  messages: Message[];
  outputSchema: Record<string, unknown> | null;
  safetyPolicy: string | null;
  temperature: number | null;
  maxOutputTokens: number | null;
  /** Which variables were used, and which of those carry untrusted input. */
  usedVariables: string[];
  untrustedVariables: string[];
}

export class PromptRegistry {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: PromptRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Creates a draft.
   *
   * The version number is assigned, never supplied. A caller choosing its own would eventually
   * choose one that exists, and "which version 3 is this" is not a question a registry should
   * permit.
   */
  async createDraft(input: {
    promptKey: string;
    organizationId: string | null;
    description: string;
    owner: string;
    system?: string | null;
    template: string;
    variables?: PromptVariable[];
    outputSchema?: Record<string, unknown> | null;
    safetyPolicy?: string | null;
    temperature?: number | null;
    maxOutputTokens?: number | null;
    components?: Record<string, string>;
    localizedTemplates?: Record<string, string>;
    actorId: string | null;
  }): Promise<PromptVersion> {
    const existing = await this.options.store.listVersions(input.promptKey, input.organizationId);
    const nextVersion = Math.max(0, ...existing.map((entry) => entry.version)) + 1;

    const draft = promptVersionSchema.parse({
      id: this.newId('prm'),
      promptKey: input.promptKey,
      version: nextVersion,
      organizationId: input.organizationId,
      description: input.description,
      owner: input.owner,
      system: input.system ?? null,
      template: input.template,
      variables: input.variables ?? [],
      outputSchema: input.outputSchema ?? null,
      safetyPolicy: input.safetyPolicy ?? null,
      temperature: input.temperature ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      components: input.components ?? {},
      localizedTemplates: input.localizedTemplates ?? {},
      status: 'draft',
      createdAt: this.now(),
      createdById: input.actorId,
    });

    this.assertValid(draft);
    return this.options.store.create(draft);
  }

  /**
   * Updates a draft.
   *
   * Only a draft. Editing stops at `in_review` for the reason phase 5 gave for workflow
   * definitions: a version somebody is reading must not change underneath them, or the reviewer
   * approves something other than what they read.
   */
  async updateDraft(
    id: string,
    organizationId: string | null,
    patch: Partial<
      Pick<
        PromptVersion,
        | 'description'
        | 'system'
        | 'template'
        | 'variables'
        | 'outputSchema'
        | 'safetyPolicy'
        | 'temperature'
        | 'maxOutputTokens'
        | 'components'
        | 'localizedTemplates'
      >
    >,
    actorId: string | null,
  ): Promise<PromptVersion> {
    const version = await this.require(id, organizationId);

    if (version.status !== 'draft') {
      throw ApiError.conflict(
        `This prompt is ${version.status} and cannot be edited. Create a new version, or ` +
          'withdraw it to draft first — a version under review must not change under the reviewer.',
        { reason: 'prompt_not_editable', promptId: id, status: version.status },
      );
    }

    const updated = { ...version, ...patch };
    this.assertValid(updated);

    const result = await this.options.store.update(id, patch);
    void actorId;
    return result!;
  }

  /** Submits a draft for review. Editing stops here. */
  async submit(id: string, organizationId: string | null, actorId: string | null): Promise<void> {
    const version = await this.require(id, organizationId);
    this.assertValid(version);

    const applied = await this.options.store.transition(id, ['draft'], { status: 'in_review' });
    if (!applied) {
      throw ApiError.conflict(`This prompt is ${version.status} and cannot be submitted.`, {
        reason: 'prompt_bad_transition',
        promptId: id,
      });
    }

    await this.audit('ai.prompt.submitted', version, actorId);
  }

  /**
   * Approves a version.
   *
   * The author cannot approve their own. Same rule as phase 5's maker-checker, and the same
   * reason: one person's opinion is then the only thing between a draft and production, and a
   * prompt reaches customers.
   */
  async approve(id: string, organizationId: string | null, actorId: string): Promise<void> {
    const version = await this.require(id, organizationId);

    if (version.createdById && version.createdById === actorId) {
      throw ApiError.forbidden(
        'The author of a prompt cannot approve it. A prompt reaches customers, and one ' +
          'person’s opinion should not be the only thing between a draft and production.',
        { reason: 'self_approval', promptId: id },
      );
    }

    const applied = await this.options.store.transition(id, ['in_review'], {
      status: 'approved',
      approvedAt: this.now(),
      approvedById: actorId,
    });

    if (!applied) {
      throw ApiError.conflict(
        `Only a prompt under review can be approved; this one is ${version.status}.`,
        { reason: 'prompt_bad_transition', promptId: id },
      );
    }

    await this.audit('ai.prompt.approved', version, actorId);
  }

  /**
   * Publishes an approved version, retiring the previous one.
   *
   * Computes the content hash. From this point the version is immutable, and `render` verifies
   * the hash on every use.
   */
  async publish(
    id: string,
    organizationId: string | null,
    actorId: string,
    options: { effectiveFrom?: Date } = {},
  ): Promise<PromptVersion> {
    const version = await this.require(id, organizationId);

    if (version.status !== 'approved') {
      throw ApiError.conflict(
        `Only an approved prompt can be published; this one is ${version.status}.`,
        { reason: 'prompt_bad_transition', promptId: id, status: version.status },
      );
    }

    if (version.approvedById === actorId) {
      // Three people: author, approver, publisher. Publication is the act that makes it live.
      throw ApiError.forbidden('The approver of a prompt cannot also publish it.', {
        reason: 'self_publication',
        promptId: id,
      });
    }

    const previous = await this.options.store.findPublished(version.promptKey, organizationId);

    const applied = await this.options.store.transition(id, ['approved'], {
      status: 'published',
      publishedAt: this.now(),
      publishedById: actorId,
      effectiveFrom: options.effectiveFrom ?? this.now(),
      contentHash: contentHashOf(version),
    });

    if (!applied) {
      throw ApiError.conflict('This prompt was changed while it was being published.', {
        reason: 'prompt_conflict',
        promptId: id,
      });
    }

    if (previous && previous.id !== id) {
      // Exactly one published version per key. Two would make "the published prompt" ambiguous,
      // and `findPublished` would return whichever the query happened to order first.
      await this.options.store.transition(previous.id, ['published'], {
        status: 'retired',
        retiredAt: this.now(),
      });
    }

    await this.audit('ai.prompt.published', version, actorId, {
      previousVersion: previous?.version ?? null,
    });

    return (await this.options.store.findById(id, organizationId))!;
  }

  /**
   * Republishes an earlier version.
   *
   * Rollback is a publication, not an edit — so the trail shows published, retired, published
   * again, which is what happened. The version must already have been approved: rollback is not
   * a way to make an unreviewed prompt live in a hurry, which is exactly when somebody would want
   * it to be.
   */
  async rollback(
    id: string,
    organizationId: string | null,
    actorId: string,
    reason: string,
  ): Promise<PromptVersion> {
    const target = await this.require(id, organizationId);

    if (!target.approvedById) {
      throw ApiError.conflict(
        'This version was never approved, so it cannot be rolled back to. Rollback republishes a ' +
          'version that was reviewed; it is not a way to skip review.',
        { reason: 'prompt_never_approved', promptId: id },
      );
    }

    const current = await this.options.store.findPublished(target.promptKey, organizationId);

    if (current) {
      await this.options.store.transition(current.id, ['published'], {
        status: 'retired',
        retiredAt: this.now(),
      });
    }

    await this.options.store.transition(target.id, ['retired', 'approved'], {
      status: 'published',
      publishedAt: this.now(),
      publishedById: actorId,
      retiredAt: null,
      contentHash: contentHashOf(target),
    });

    await this.audit('ai.prompt.rolled_back', target, actorId, {
      reason,
      from: current?.version ?? null,
    });

    return (await this.options.store.findById(id, organizationId))!;
  }

  /**
   * Renders the published version of a prompt.
   *
   * The normal path. Verifies the content hash first: a published prompt that has been changed in
   * the database is a prompt nobody reviewed, and rendering it would put unreviewed text in front
   * of a model and a customer.
   */
  async render(
    promptKey: string,
    variables: Record<string, VariableValue>,
    options: { organizationId: string | null; locale?: string; version?: number } = {
      organizationId: null,
    },
  ): Promise<RenderedPrompt> {
    const version =
      options.version === undefined
        ? await this.options.store.findPublished(promptKey, options.organizationId)
        : await this.options.store.findVersion(promptKey, options.version, options.organizationId);

    if (!version) {
      const keys = await this.options.store.listKeys(options.organizationId);
      throw ApiError.notFound(
        options.version === undefined
          ? `No published prompt "${promptKey}". Registered keys: ${keys.slice(0, 10).join(', ') || '(none)'}.`
          : `No version ${options.version} of prompt "${promptKey}".`,
      );
    }

    if (version.status === 'published') {
      this.assertUntampered(version);
    }

    const result = renderTemplate(version.template, variables, version.variables, {
      components: version.components,
      locale: options.locale,
      localizedTemplates: version.localizedTemplates,
    });

    const messages: Message[] = [];
    if (version.system) {
      // The system message is rendered too, with the same variables. A system prompt with an
      // unsubstituted placeholder is a prompt asking the model to interpret template syntax.
      const system = renderTemplate(version.system, variables, version.variables, {
        components: version.components,
      });
      messages.push(message.system(system.text));
    }
    messages.push(message.user(result.text));

    const untrusted = version.variables
      .filter((variable) => variable.untrusted && result.used.includes(variable.name))
      .map((variable) => variable.name);

    return {
      promptKey: version.promptKey,
      version: version.version,
      messages,
      outputSchema: version.outputSchema,
      safetyPolicy: version.safetyPolicy,
      temperature: version.temperature,
      maxOutputTokens: version.maxOutputTokens,
      usedVariables: result.used,
      untrustedVariables: untrusted,
    };
  }

  /** Renders without publishing, for a draft under test. */
  async preview(
    id: string,
    organizationId: string | null,
    variables: Record<string, VariableValue>,
    locale?: string,
  ): Promise<RenderedPrompt> {
    const version = await this.require(id, organizationId);

    return this.render(version.promptKey, variables, {
      organizationId,
      version: version.version,
      locale,
    });
  }

  /**
   * Compares two versions, by consequence rather than by diff.
   *
   * A raw text diff of two prompts surfaces every reworded sentence with the same weight as a
   * removed safety instruction. This separates the changes that alter the *contract* — variables,
   * output schema, safety policy — from the ones that alter the wording.
   */
  async compare(
    promptKey: string,
    fromVersion: number,
    toVersion: number,
    organizationId: string | null,
  ): Promise<{
    contractChanges: string[];
    safetyChanges: string[];
    wordingChanged: boolean;
    from: number;
    to: number;
  }> {
    const [from, to] = await Promise.all([
      this.options.store.findVersion(promptKey, fromVersion, organizationId),
      this.options.store.findVersion(promptKey, toVersion, organizationId),
    ]);

    if (!from || !to) {
      throw ApiError.notFound(`Both versions of "${promptKey}" must exist to compare them.`);
    }

    const contractChanges: string[] = [];
    const safetyChanges: string[] = [];

    const fromVariables = new Map(from.variables.map((variable) => [variable.name, variable]));
    const toVariables = new Map(to.variables.map((variable) => [variable.name, variable]));

    for (const [name, variable] of toVariables) {
      const before = fromVariables.get(name);
      if (!before) {
        contractChanges.push(
          `Variable "${name}" added (${variable.required ? 'required' : 'optional'}).`,
        );
      } else if (before.required !== variable.required) {
        contractChanges.push(
          `Variable "${name}" became ${variable.required ? 'required' : 'optional'}.`,
        );
      } else if (before.type !== variable.type) {
        contractChanges.push(`Variable "${name}" changed type: ${before.type} → ${variable.type}.`);
      } else if (before.untrusted && !variable.untrusted) {
        // The one that matters: a variable that stops being marked untrusted stops being scanned
        // for injection, and nothing about the rendered prompt would show it.
        safetyChanges.push(
          `Variable "${name}" is no longer marked untrusted, so it is no longer scanned for ` +
            'prompt injection.',
        );
      }
    }

    for (const name of fromVariables.keys()) {
      if (!toVariables.has(name)) contractChanges.push(`Variable "${name}" removed.`);
    }

    if (JSON.stringify(from.outputSchema) !== JSON.stringify(to.outputSchema)) {
      contractChanges.push('The output schema changed. Callers parsing the result may break.');
    }

    if (from.safetyPolicy !== to.safetyPolicy) {
      safetyChanges.push(
        `The safety policy changed: ${from.safetyPolicy ?? '(none)'} → ${to.safetyPolicy ?? '(none)'}.`,
      );
    }

    return {
      contractChanges,
      safetyChanges,
      wordingChanged: from.template !== to.template || from.system !== to.system,
      from: fromVersion,
      to: toVersion,
    };
  }

  async listVersions(promptKey: string, organizationId: string | null): Promise<PromptVersion[]> {
    return this.options.store.listVersions(promptKey, organizationId);
  }

  async listKeys(organizationId: string | null): Promise<string[]> {
    return this.options.store.listKeys(organizationId);
  }

  /**
   * Structural checks. Run at every state change, and by `trustos ai validate-prompts`.
   *
   * Three drifts this catches, all of which render as *something* and are therefore invisible:
   * an unclosed section, a variable used but not declared, and a component that does not exist.
   */
  assertValid(version: PromptVersion): void {
    const problems: Array<{ path: string; message: string }> = [];

    for (const problem of validateTemplateSyntax(version.template)) {
      problems.push({ path: 'template', message: problem });
    }
    if (version.system) {
      for (const problem of validateTemplateSyntax(version.system)) {
        problems.push({ path: 'system', message: problem });
      }
    }

    const declared = new Set(version.variables.map((variable) => variable.name));
    const referenced = new Set([
      ...referencedVariables(version.template),
      ...(version.system ? referencedVariables(version.system) : []),
      ...Object.values(version.components).flatMap(referencedVariables),
    ]);

    for (const name of referenced) {
      if (!declared.has(name)) {
        problems.push({
          path: 'variables',
          message:
            `"${name}" is used in the template but not declared. It would render as empty, and ` +
            'a prompt silently missing a value is worse than one that fails to render.',
        });
      }
    }

    for (const name of declared) {
      if (!referenced.has(name)) {
        problems.push({
          path: 'variables',
          message: `"${name}" is declared but never used. The template and its schema have drifted.`,
        });
      }
    }

    const components = new Set(Object.keys(version.components));
    for (const name of [
      ...referencedComponents(version.template),
      ...(version.system ? referencedComponents(version.system) : []),
    ]) {
      if (!components.has(name)) {
        problems.push({ path: 'components', message: `The component "${name}" is not defined.` });
      }
    }

    if (problems.length > 0) {
      throw ApiError.validation(problems, `The prompt "${version.promptKey}" is not valid.`);
    }
  }

  /**
   * Verifies a published version has not changed since publication.
   *
   * The third layer of immutability, after the service refusing edits and a database trigger.
   * This one catches a direct `UPDATE`, which the application's own credentials can perform — so
   * "the service refuses" is not a guarantee.
   */
  private assertUntampered(version: PromptVersion): void {
    if (!version.contentHash) return;

    const actual = contentHashOf(version);
    if (actual === version.contentHash) return;

    this.options.logger?.error(
      {
        promptKey: version.promptKey,
        version: version.version,
        expected: version.contentHash,
        actual,
      },
      'published prompt content does not match its hash',
    );

    throw ApiError.internal(
      `The published prompt "${version.promptKey}" v${version.version} has been modified since ` +
        'it was published. It will not be rendered: unreviewed text would reach a model and a ' +
        'customer. Publish a new version instead of editing a published one.',
      { reason: 'prompt_tampered', promptKey: version.promptKey, version: version.version },
    );
  }

  private async require(id: string, organizationId: string | null): Promise<PromptVersion> {
    const version = await this.options.store.findById(id, organizationId);
    if (!version) throw ApiError.notFound(`No prompt version with id "${id}".`);
    return version;
  }

  private async audit(
    action: string,
    version: PromptVersion,
    actorId: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.audit?.record({
      action,
      entityType: 'PromptVersion',
      entityId: version.id,
      actorId,
      organizationId: version.organizationId,
      after: {
        promptKey: version.promptKey,
        version: version.version,
        owner: version.owner,
        ...extra,
      },
    });
  }
}

/**
 * The content hash.
 *
 * Over the fields that change what the model sees. Not over status, timestamps or who approved
 * it — those change legitimately after publication, and including them would make the hash fail
 * on the retirement of the version it protects.
 */
export function contentHashOf(version: PromptVersion): string {
  const material = JSON.stringify({
    system: version.system,
    template: version.template,
    // Sorted, so a reordering in the database does not read as tampering.
    variables: [...version.variables].sort((a, b) => a.name.localeCompare(b.name)),
    outputSchema: version.outputSchema,
    safetyPolicy: version.safetyPolicy,
    components: Object.fromEntries(Object.entries(version.components).sort()),
    localizedTemplates: Object.fromEntries(Object.entries(version.localizedTemplates).sort()),
  });

  return createHash('sha256').update(material).digest('hex');
}
