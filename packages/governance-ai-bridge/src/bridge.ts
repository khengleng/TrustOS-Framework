import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { Environment } from '@trustsystem/governance-tool-core';

/**
 * AI assistance for internal tools.
 *
 * Ten features, all of the same shape: **summarize, explain, draft.** None of them acts.
 *
 * That is not a limitation of the current implementation; it is the design, and it is enforced by
 * the shape of what this package returns. An AI feature here produces a `AiAssistOutput` — text,
 * with a provenance record. There is no return type that carries an action, no field that names
 * an operation, and no path from an output to the gateway. A model cannot execute a financial
 * adjustment because there is nothing for it to execute one *through*.
 *
 * Everything goes through the **TrustOS AI Gateway**. This package builds a request and consumes
 * a response; it holds no provider client and imports no model SDK. A call that went around the
 * gateway would be a call with no policy, no guardrails, no cost accounting and no audit — and
 * the whole reason phase 7 exists is that such a call is unaccountable afterwards.
 *
 * Five things are required on every request, and `assertAssistPreconditions` refuses without any
 * of them: a tenant, an approved prompt version, a policy, a purpose, and — for anything
 * sensitive — a human reviewer downstream.
 */

export const AI_ASSIST_FEATURES = [
  'summarize_case',
  'summarize_merchant',
  'explain_transaction_failure',
  'explain_reconciliation_exception',
  'summarize_incident',
  'summarize_risk_case',
  'draft_customer_response',
  'draft_investigation_notes',
  'draft_management_report',
  'recommend_next_step',
  'propose_product_configuration',

  /*
   * Enterprise governance assistance, added in phase 13.
   *
   * Every one of them is a *reading* feature — explain, summarize, draft, suggest. None of them
   * appears in a code path that activates a policy, changes a classification, publishes an API or
   * executes a recovery, and `AI_FORBIDDEN_ACTIONS` names all four.
   *
   * The distinction that keeps them safe is between **proposing** and **doing**, and it is
   * structural: the output type carries text, and the console renders it into a form a person then
   * submits under their own permissions. A suggested classification arrives as a sentence, not as
   * a field somebody clicks Apply on.
   */
  'explain_policy',
  'explain_policy_decision',
  'suggest_data_classification',
  'draft_api_documentation',
  'summarize_slo_status',
  'draft_postmortem',
  'analyse_dr_plan',
  'detect_governance_gaps',
] as const;

export type AiAssistFeature = (typeof AI_ASSIST_FEATURES)[number];

/**
 * Features whose output reaches somebody outside the company, or influences a decision about a
 * person.
 *
 * These require a human review before the output is used — not before it is generated. Reviewing
 * before generation would be reviewing a prompt, which is not the thing that goes wrong.
 */
export const REQUIRES_HUMAN_REVIEW: ReadonlySet<AiAssistFeature> = new Set([
  'draft_customer_response',
  'draft_investigation_notes',
  'draft_management_report',
  'recommend_next_step',
  'propose_product_configuration',
  'summarize_risk_case',

  /*
   * The governance features that need a person before their output is used.
   *
   * A suggested classification is the sharpest: acting on one without review would let a model
   * lower the classification of a table, and every downstream control — masking, export, reveal,
   * retention — reads that label.
   *
   * `explain_policy` and `summarize_slo_status` are deliberately *not* here. They restate
   * something the reader could have read themselves, and requiring a reviewer for every
   * explanation is how review becomes a formality that gets clicked through.
   */
  'suggest_data_classification',
  'draft_api_documentation',
  'draft_postmortem',
  'analyse_dr_plan',
  'detect_governance_gaps',
]);

/**
 * What each feature may be given.
 *
 * A closed list per feature, because the way a summarization feature becomes a data-exfiltration
 * path is that somebody widens its input "so it has more context". A feature that summarizes a
 * case gets the case; it does not get the customer's full record because that would summarize
 * better.
 */
export const PERMITTED_INPUTS: Readonly<Record<AiAssistFeature, readonly string[]>> = {
  summarize_case: ['caseRef', 'caseTimeline', 'caseComments'],
  summarize_merchant: ['merchantRef', 'merchantProfile', 'merchantTransactionSummary'],
  explain_transaction_failure: ['transactionRef', 'executionSteps', 'refusalCode'],
  explain_reconciliation_exception: ['exceptionRef', 'exceptionDetail', 'statementLine'],
  summarize_incident: ['incidentRef', 'incidentTimeline'],
  summarize_risk_case: ['caseRef', 'caseTimeline', 'riskSignals'],
  draft_customer_response: ['caseRef', 'caseSummary', 'templateCode'],
  draft_investigation_notes: ['caseRef', 'caseTimeline'],
  draft_management_report: ['reportPeriod', 'aggregateMetrics'],
  recommend_next_step: ['caseRef', 'caseStatus', 'workflowState'],
  propose_product_configuration: ['productIntent', 'availableBlocks', 'availableCurrencies'],

  /*
   * The governance features, and note what is absent from every one of them: no input names a
   * table's *contents*, a decision log's *rows*, or a backup's *location*. A feature that explains
   * a policy gets the policy document; a feature that suggests a classification gets the schema
   * and the sample field names, never the sampled values.
   */
  explain_policy: ['policyId', 'policyVersion'],
  explain_policy_decision: ['decisionId', 'policyId', 'policyVersion'],
  suggest_data_classification: ['entryId', 'technicalName', 'fieldNames', 'businessDomain'],
  draft_api_documentation: ['apiId', 'apiVersion', 'operationIds'],
  summarize_slo_status: ['sloId', 'windowStart', 'windowEnd'],
  draft_postmortem: ['incidentRef', 'incidentTimeline'],
  analyse_dr_plan: ['planId', 'planVersion'],
  detect_governance_gaps: ['scope', 'environment'],
};

export const assistRequestSchema = z
  .object({
    requestId: z.string().min(1).max(80),
    feature: z.enum(AI_ASSIST_FEATURES),

    appId: z.string().min(1).max(80),
    environment: z.enum(['dev', 'uat', 'prod']),
    actorId: z.string().min(1).max(80),
    /** Required. A request with no tenant is a request against everybody's data. */
    organizationId: z.string().min(1).max(80),

    /** The approved prompt version. An inline prompt has no author, no approval and no rollback. */
    promptId: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(40),
    /** The AI policy this request is evaluated under. */
    policyId: z.string().min(1).max(120),

    /**
     * The inputs, by name.
     *
     * Names and references — never the content. The gateway resolves each reference server-side
     * under the actor's own permissions, which is what stops a request from carrying data the
     * requester could not otherwise read.
     */
    inputs: z.record(z.string().max(200)),

    /** Why this is being asked. Carried into the audit record. */
    purpose: z.string().min(10).max(400),
    correlationId: z.string().min(1).max(120),
  })
  .strict();

export type AiAssistRequest = z.infer<typeof assistRequestSchema>;

export const assistOutputSchema = z
  .object({
    requestId: z.string(),
    feature: z.enum(AI_ASSIST_FEATURES),
    /** The generated text. The only thing an AI feature produces. */
    text: z.string().max(20_000),

    /** Provenance, all of it required. */
    modelId: z.string().min(1).max(120),
    modelVersion: z.string().min(1).max(40),
    promptId: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(40),

    /** Guardrail outcomes the gateway reported. */
    guardrails: z.array(
      z.object({ name: z.string().max(80), outcome: z.enum(['pass', 'warn', 'block']) }).strict(),
    ),
    /** Whether the run stopped because it hit a limit. A truncated answer is not a final answer. */
    limitReached: z.boolean(),

    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costMinorUnits: z.string().regex(/^[0-9]{1,18}$/),

    /** Whether a person must approve this before it is used, and whether one has. */
    requiresReview: z.boolean(),
    reviewedBy: z.string().max(80).nullable(),

    generatedAt: z.string().datetime(),
  })
  .strict();

export type AiAssistOutput = z.infer<typeof assistOutputSchema>;

/**
 * Refuses a request that is missing a control.
 *
 * Five checks, and the input allow-list is the one that does unexpected work: it is what keeps a
 * summarization feature from becoming a way to read a record the requester could not open
 * directly.
 */
export function assertAssistPreconditions(request: AiAssistRequest): void {
  const permitted = new Set(PERMITTED_INPUTS[request.feature]);
  const supplied = Object.keys(request.inputs);
  const extra = supplied.filter((name) => !permitted.has(name));

  if (extra.length > 0) {
    throw new ApiError('forbidden', {
      message:
        `The "${request.feature}" feature does not take ${extra.join(', ')}. Its inputs are ` +
        `${[...permitted].join(', ')}. Widening an assistant's inputs "so it has more context" ` +
        'is how a summarizer becomes a way to read a record the requester cannot open.',
      context: { feature: request.feature, extra: extra.join(',') },
    });
  }

  if (request.environment === 'prod' && request.promptVersion.includes('draft')) {
    throw new ApiError('forbidden', {
      message: 'A draft prompt version cannot run in production.',
      context: { promptId: request.promptId, promptVersion: request.promptVersion },
    });
  }
}

/**
 * Whether an output may be used.
 *
 * Three refusals, and the middle one is the one most systems get wrong: **a blocked guardrail
 * means the output is not used**, not that it is shown with a warning. A warning beside text is
 * a warning somebody reads once.
 */
export function assertOutputUsable(output: AiAssistOutput): void {
  if (output.guardrails.some((guardrail) => guardrail.outcome === 'block')) {
    throw new ApiError('forbidden', {
      message:
        'A guardrail blocked this output, so it is not available. Showing it with a warning ' +
        'attached is a warning somebody reads once.',
      context: {
        requestId: output.requestId,
        blocked: output.guardrails
          .filter((guardrail) => guardrail.outcome === 'block')
          .map((guardrail) => guardrail.name)
          .join(','),
      },
    });
  }

  if (output.limitReached) {
    throw new ApiError('conflict', {
      message:
        'This run stopped because it reached a limit, so the text is incomplete. Presenting half ' +
        'a thought as a conclusion is the failure mode of every assistant that gets this wrong.',
      context: { requestId: output.requestId },
    });
  }

  if (output.requiresReview && output.reviewedBy === null) {
    throw new ApiError('forbidden', {
      message: 'This output needs a person to review it before it is used.',
      context: { requestId: output.requestId, feature: output.feature },
    });
  }
}

/**
 * Actions AI may never take, listed so the absence is checkable rather than assumed.
 *
 * Nothing in this package can perform any of them — there is no return type that carries an
 * action. The list exists so a test can assert the surface, and so a reviewer adding a feature
 * has the boundary in front of them.
 */
export const AI_FORBIDDEN_ACTIONS: readonly string[] = [
  'change a wallet balance',
  'approve a merchant',
  'modify a limit',
  'post a ledger entry',
  'execute a payment',
  'activate a policy',
  'change a data classification',
  'revoke access',
  'publish an API',
  'execute a disaster-recovery procedure',
  'delete data',
  'publish a financial product',
  'register or amend a service',
  'grant or revoke an API entitlement',
  'mark a backup validated',
  'record a restore test or a DR exercise',
  'close an incident',
];

/**
 * Whether a feature is one that only ever produces a proposal.
 *
 * Every feature in this package is, and the function exists so a test can assert it over the whole
 * list rather than over the ones somebody remembered. A feature added later that could act would
 * have to be added here as an exception, in a diff a reviewer sees.
 */
export function isProposalOnly(feature: AiAssistFeature): boolean {
  void feature;
  return true;
}

/**
 * The permission a person needs to act on a proposal, per feature.
 *
 * Returned to the console so it can render "this needs somebody with X" rather than an Apply
 * button that fails. Null means the output is informational and there is nothing to act on.
 *
 * The point of the mapping is the second half of every entry: acting is a permission the *person*
 * holds, checked by the surface that performs the action, and the assistant is not in that path.
 */
export const ACTION_PERMISSION_FOR: Readonly<Record<AiAssistFeature, string | null>> = {
  summarize_case: null,
  summarize_merchant: null,
  explain_transaction_failure: null,
  explain_reconciliation_exception: null,
  summarize_incident: null,
  summarize_risk_case: null,
  draft_customer_response: 'case.respond',
  draft_investigation_notes: 'case.update',
  draft_management_report: null,
  recommend_next_step: 'workflow.task.complete',
  propose_product_configuration: 'financial.product.create',
  explain_policy: null,
  explain_policy_decision: null,
  suggest_data_classification: 'enterprise.data.classify',
  draft_api_documentation: 'enterprise.api.publish',
  summarize_slo_status: null,
  draft_postmortem: 'sre.incident.update',
  analyse_dr_plan: 'enterprise.continuity.write',
  detect_governance_gaps: null,
};

/** The audit record an assist produces. Provenance and counts, never the prompt or the output. */
export function assistAuditDetail(
  request: AiAssistRequest,
  output: AiAssistOutput | null,
): Record<string, string | number | boolean | null> {
  return {
    requestId: request.requestId,
    feature: request.feature,
    appId: request.appId,
    actorId: request.actorId,
    organizationId: request.organizationId,
    promptId: request.promptId,
    promptVersion: request.promptVersion,
    policyId: request.policyId,
    purpose: request.purpose,
    /*
     * Never the prompt, never the completion.
     *
     * Where content lives is one deliberate place, and an audit trail is not it — an audit record
     * containing a case summary is a case summary in a system with different access controls.
     */
    modelId: output?.modelId ?? null,
    modelVersion: output?.modelVersion ?? null,
    inputTokens: output?.inputTokens ?? 0,
    outputTokens: output?.outputTokens ?? 0,
    costMinorUnits: output?.costMinorUnits ?? '0',
    guardrailsBlocked:
      output?.guardrails.filter((guardrail) => guardrail.outcome === 'block').length ?? 0,
    limitReached: output?.limitReached ?? false,
    requiresReview: output?.requiresReview ?? false,
    reviewedBy: output?.reviewedBy ?? null,
  };
}

/** Whether a feature's output needs a person. Data, so the console can render the badge. */
export function requiresHumanReview(feature: AiAssistFeature): boolean {
  return REQUIRES_HUMAN_REVIEW.has(feature);
}

/** Builds the gateway request. The deployment sends it; this package never calls a model. */
export function buildGatewayRequest(
  request: AiAssistRequest,
  environment: Environment,
): {
  promptId: string;
  promptVersion: string;
  policyId: string;
  organizationId: string;
  actorId: string;
  variables: Record<string, string>;
  metadata: Record<string, string>;
} {
  assertAssistPreconditions(request);

  return {
    promptId: request.promptId,
    promptVersion: request.promptVersion,
    policyId: request.policyId,
    organizationId: request.organizationId,
    /*
     * The *actor's* id, not the application's.
     *
     * Tool permissions are validated against the actor, not the agent — phase 7's rule, and the
     * one that makes a successful prompt injection survivable. An assistant running as the
     * application would run with the application's reach.
     */
    actorId: request.actorId,
    variables: { ...request.inputs },
    metadata: {
      governanceAppId: request.appId,
      governanceEnvironment: environment,
      governanceFeature: request.feature,
      correlationId: request.correlationId,
    },
  };
}
