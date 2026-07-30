import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { AiRequestContext } from '@trustos/ai-sdk';

/**
 * The AI policy engine.
 *
 * What a tenant is allowed to do with AI: which models, which tools, which knowledge bases, how
 * much it may cost, how long it may run, and when a human must approve.
 *
 * Two design decisions, both inherited from phase 4's authorization engine because they were
 * right there and are right here:
 *
 *   1. **Default deny for the things that matter.** An unlisted model is allowed by default and
 *      an unlisted *tool* is not, and the asymmetry is deliberate: adding a model changes what
 *      answers, while adding a tool changes what the system can *do*. A policy that silently
 *      permitted a new tool would be a policy that permits whatever gets added next.
 *   2. **A decision is explicable.** Every result carries the rule that produced it. "Denied" with
 *      no reason is an unfixable support ticket.
 *
 * Policies resolve most-specific-first: an agent policy overrides a tenant policy overrides the
 * platform default. Never merged — merging two policies produces one nobody wrote, and the
 * question "why was this allowed" stops having an answer.
 */

export const budgetSchema = z
  .object({
    /** Cents per request. A single runaway request is the most common cost incident. */
    maxCostCentsPerRequest: z.number().min(0).nullable().default(null),
    maxCostCentsPerDay: z.number().min(0).nullable().default(null),
    maxCostCentsPerMonth: z.number().min(0).nullable().default(null),
    /**
     * Warn at this fraction of a budget.
     *
     * 0.8 — enough warning to act, late enough not to be noise. Reaching a budget with no prior
     * signal is how an AI feature gets switched off during business hours.
     */
    warnAtFraction: z.number().min(0).max(1).default(0.8),
  })
  .strict();

export type Budget = z.infer<typeof budgetSchema>;

export const aiPolicySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).default(''),

    /**
     * Which policy this applies to. Most specific wins.
     *
     *   * `platform` — the fallback. Applies when nothing else does.
     *   * `organization` — one tenant.
     *   * `agent` — one agent, in one tenant or across all of them.
     */
    scope: z.union([
      z.object({ kind: z.literal('platform') }).strict(),
      z.object({ kind: z.literal('organization'), organizationId: z.string().max(64) }).strict(),
      z
        .object({
          kind: z.literal('agent'),
          agentId: z.string().max(120),
          organizationId: z.string().max(64).nullable().default(null),
        })
        .strict(),
    ]),

    /**
     * Models this policy permits. Empty means every registered model.
     *
     * Allowed-by-default, because the registry is already curated and a new model is a change to
     * what answers rather than to what the system can do.
     */
    allowedModels: z.array(z.string().max(120)).max(500).default([]),
    /** Explicitly forbidden, overriding `allowedModels`. For retiring a model per tenant. */
    deniedModels: z.array(z.string().max(120)).max(500).default([]),

    /** Providers this policy permits. Empty means all. For a data-residency requirement. */
    allowedProviders: z.array(z.string().max(60)).max(50).default([]),

    /**
     * Tools this policy permits.
     *
     * **Denied by default.** Empty means *no tools*, not all of them. A tool changes what the
     * system can do, and a policy that permitted whatever was added next would not be a policy.
     */
    allowedTools: z.array(z.string().max(120)).max(500).default([]),

    /** Knowledge bases this policy permits. Empty means none, for the same reason. */
    allowedKnowledgeBases: z.array(z.string().max(120)).max(500).default([]),

    budget: budgetSchema.default({}),

    maxOutputTokens: z.number().int().min(1).max(200_000).nullable().default(null),
    /** Ceiling on one agent run, in milliseconds. */
    maxRuntimeMs: z.number().int().min(1000).max(3_600_000).nullable().default(null),
    /** Ceiling on agent steps. Stops a tool loop that never converges. */
    maxAgentSteps: z.number().int().min(1).max(100).nullable().default(null),

    /**
     * Output in these categories must be reviewed by a person before it is returned.
     *
     * Matches the risk categories in `@trustos/content-filter`.
     */
    reviewRequiredCategories: z.array(z.string().max(60)).max(50).default([]),

    /** Every output from this policy's scope needs review. For a high-stakes agent. */
    reviewAllOutput: z.boolean().default(false),

    /** The guardrail profile to apply. */
    guardrailProfile: z.string().max(120).nullable().default(null),

    /**
     * Whether responses may be cached.
     *
     * Off by default. A cache keyed on prompt text can return one tenant's answer to another if
     * the key is built carelessly, and "carelessly" is the default state of a cache key. See
     * `@trustos/ai-cache`.
     */
    allowCaching: z.boolean().default(false),
  })
  .strict();

export type AiPolicy = z.infer<typeof aiPolicySchema>;

export type PolicyEffect = 'allow' | 'deny';

export interface PolicyDecision {
  effect: PolicyEffect;
  /** The policy that decided. Always named — "denied" with no reason is unfixable. */
  policyName: string;
  /** What specifically was checked and why it failed. */
  reason: string;
  /** For the audit record. */
  detail?: Record<string, unknown>;
}

export interface PolicyCheckInput {
  context: Pick<AiRequestContext, 'organizationId' | 'agentId'>;
  modelId?: string;
  provider?: string;
  toolNames?: string[];
  knowledgeBaseIds?: string[];
  estimatedCostCents?: number;
  requestedOutputTokens?: number;
}

export class AiPolicyEngine {
  private readonly policies: AiPolicy[] = [];

  constructor(policies: unknown[] = []) {
    for (const policy of policies) this.register(policy);

    if (!this.policies.some((policy) => policy.scope.kind === 'platform')) {
      /*
       * There is always a platform policy.
       *
       * Without one, a tenant with no policy of its own would fall through to "no policy", and
       * the only sensible readings of that are "allow everything" or "deny everything" — the
       * first is unsafe and the second makes the platform unusable. An explicit default is
       * neither.
       */
      this.register(
        aiPolicySchema.parse({
          name: 'platform-default',
          description:
            'The fallback. Models allowed, tools denied, no budget ceiling, no review required.',
          scope: { kind: 'platform' },
        }),
      );
    }
  }

  register(input: unknown): AiPolicy {
    const parsed = aiPolicySchema.safeParse(input);

    if (!parsed.success) {
      const name = (input as { name?: string } | null)?.name ?? '(unnamed)';
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `${name}.${issue.path.join('.')}`,
          message: issue.message,
        })),
        `The AI policy "${name}" is not configured correctly.`,
      );
    }

    this.policies.push(parsed.data);
    return parsed.data;
  }

  /**
   * The policy that applies, most specific first.
   *
   * Never merged. Merging two policies produces one nobody wrote, and "why was this allowed"
   * stops having an answer — the same reasoning phase 4 applied to permission resolution.
   */
  resolve(context: Pick<AiRequestContext, 'organizationId' | 'agentId'>): AiPolicy {
    const candidates = this.policies.filter((policy) => this.applies(policy, context));

    // Agent-and-tenant, then agent-any-tenant, then tenant, then platform.
    const ranked = candidates.sort((a, b) => this.specificity(b) - this.specificity(a));
    return ranked[0]!;
  }

  private applies(
    policy: AiPolicy,
    context: Pick<AiRequestContext, 'organizationId' | 'agentId'>,
  ): boolean {
    if (policy.scope.kind === 'platform') return true;

    if (policy.scope.kind === 'organization') {
      return context.organizationId === policy.scope.organizationId;
    }

    if (policy.scope.agentId !== context.agentId) return false;
    if (policy.scope.organizationId === null) return true;
    return policy.scope.organizationId === context.organizationId;
  }

  private specificity(policy: AiPolicy): number {
    if (policy.scope.kind === 'platform') return 0;
    if (policy.scope.kind === 'organization') return 1;
    return policy.scope.organizationId === null ? 2 : 3;
  }

  /**
   * Checks a request.
   *
   * Returns every violation rather than the first, because a caller fixing one only to hit the
   * next is a caller making four round trips to learn what they could have learned in one.
   */
  check(input: PolicyCheckInput): {
    allowed: boolean;
    decisions: PolicyDecision[];
    policy: AiPolicy;
  } {
    const policy = this.resolve(input.context);
    const decisions: PolicyDecision[] = [];

    if (input.modelId) {
      if (policy.deniedModels.includes(input.modelId)) {
        decisions.push({
          effect: 'deny',
          policyName: policy.name,
          reason: `The model "${input.modelId}" is explicitly denied by this policy.`,
          detail: { modelId: input.modelId },
        });
      } else if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(input.modelId)) {
        decisions.push({
          effect: 'deny',
          policyName: policy.name,
          reason:
            `The model "${input.modelId}" is not in this policy's allowed list. Allowed: ` +
            `${policy.allowedModels.join(', ')}.`,
          detail: { modelId: input.modelId, allowed: policy.allowedModels },
        });
      }
    }

    if (
      input.provider &&
      policy.allowedProviders.length > 0 &&
      !policy.allowedProviders.includes(input.provider)
    ) {
      decisions.push({
        effect: 'deny',
        policyName: policy.name,
        reason:
          `The provider "${input.provider}" is not permitted. Allowed: ` +
          `${policy.allowedProviders.join(', ')}. This is usually a data-residency requirement.`,
        detail: { provider: input.provider },
      });
    }

    for (const tool of input.toolNames ?? []) {
      // Denied by default: an empty allow-list means no tools.
      if (!policy.allowedTools.includes(tool)) {
        decisions.push({
          effect: 'deny',
          policyName: policy.name,
          reason:
            `The tool "${tool}" is not permitted by this policy. Tools are denied by default — ` +
            'add it to allowedTools deliberately, because a tool changes what the system can do.',
          detail: { tool, allowed: policy.allowedTools },
        });
      }
    }

    for (const knowledgeBase of input.knowledgeBaseIds ?? []) {
      if (!policy.allowedKnowledgeBases.includes(knowledgeBase)) {
        decisions.push({
          effect: 'deny',
          policyName: policy.name,
          reason: `The knowledge base "${knowledgeBase}" is not permitted by this policy.`,
          detail: { knowledgeBase },
        });
      }
    }

    if (
      input.estimatedCostCents !== undefined &&
      policy.budget.maxCostCentsPerRequest !== null &&
      input.estimatedCostCents > policy.budget.maxCostCentsPerRequest
    ) {
      decisions.push({
        effect: 'deny',
        policyName: policy.name,
        reason:
          `This request is estimated at ${input.estimatedCostCents.toFixed(2)}c and the ` +
          `per-request ceiling is ${policy.budget.maxCostCentsPerRequest}c. A single runaway ` +
          'request is the most common cost incident.',
        detail: { estimatedCostCents: input.estimatedCostCents },
      });
    }

    if (
      input.requestedOutputTokens !== undefined &&
      policy.maxOutputTokens !== null &&
      input.requestedOutputTokens > policy.maxOutputTokens
    ) {
      decisions.push({
        effect: 'deny',
        policyName: policy.name,
        reason: `This policy caps output at ${policy.maxOutputTokens} tokens; ${input.requestedOutputTokens} was asked for.`,
        detail: { requestedOutputTokens: input.requestedOutputTokens },
      });
    }

    return { allowed: decisions.length === 0, decisions, policy };
  }

  /** Throws the first violation, for a caller that just wants the request to stop. */
  assert(input: PolicyCheckInput): AiPolicy {
    const result = this.check(input);

    if (!result.allowed) {
      const first = result.decisions[0]!;
      throw ApiError.forbidden(first.reason, {
        reason: 'policy_denied',
        policy: first.policyName,
        violations: result.decisions.length,
        ...first.detail,
      });
    }

    return result.policy;
  }

  /** Whether output from this scope needs a person to see it before a customer does. */
  requiresReview(
    context: Pick<AiRequestContext, 'organizationId' | 'agentId'>,
    categories: string[] = [],
  ): { required: boolean; reason: string | null; policyName: string } {
    const policy = this.resolve(context);

    if (policy.reviewAllOutput) {
      return {
        required: true,
        reason: 'This policy requires every output to be reviewed.',
        policyName: policy.name,
      };
    }

    const matched = categories.filter((category) =>
      policy.reviewRequiredCategories.includes(category),
    );

    if (matched.length > 0) {
      return {
        required: true,
        reason: `Output flagged as ${matched.join(', ')}, which this policy requires review for.`,
        policyName: policy.name,
      };
    }

    return { required: false, reason: null, policyName: policy.name };
  }

  /** For `trustos ai doctor` and the policy admin view. */
  describe(): Array<{
    name: string;
    scope: string;
    specificity: number;
    models: string;
    tools: string;
    budget: string;
  }> {
    return this.policies
      .map((policy) => ({
        name: policy.name,
        scope:
          policy.scope.kind === 'platform'
            ? 'platform'
            : policy.scope.kind === 'organization'
              ? `organization:${policy.scope.organizationId}`
              : `agent:${policy.scope.agentId}${policy.scope.organizationId ? `@${policy.scope.organizationId}` : ''}`,
        specificity: this.specificity(policy),
        models:
          policy.allowedModels.length === 0
            ? 'all registered'
            : `${policy.allowedModels.length} allowed`,
        tools:
          policy.allowedTools.length === 0
            ? 'none (denied by default)'
            : `${policy.allowedTools.length} allowed`,
        budget:
          policy.budget.maxCostCentsPerDay === null
            ? 'no daily ceiling'
            : `${policy.budget.maxCostCentsPerDay}c/day`,
      }))
      .sort((a, b) => b.specificity - a.specificity || a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.policies.length;
  }
}
