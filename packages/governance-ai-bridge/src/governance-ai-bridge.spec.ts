import { describe, expect, it } from 'vitest';
import {
  ACTION_PERMISSION_FOR,
  AI_ASSIST_FEATURES,
  AI_FORBIDDEN_ACTIONS,
  PERMITTED_INPUTS,
  assertAssistPreconditions,
  assertOutputUsable,
  assistAuditDetail,
  assistOutputSchema,
  assistRequestSchema,
  buildGatewayRequest,
  isProposalOnly,
  requiresHumanReview,
} from './index';

const NOW = '2026-06-01T12:00:00.000Z';

function request(overrides: Record<string, unknown> = {}) {
  return assistRequestSchema.parse({
    requestId: 'air_1',
    feature: 'summarize_case',
    appId: 'risk-compliance-console',
    environment: 'prod',
    actorId: 'usr_risk',
    organizationId: 'org_a',
    promptId: 'prompt.summarize_case',
    promptVersion: '3.1.0',
    policyId: 'policy.internal_assist',
    inputs: { caseRef: 'cas_9', caseTimeline: 'ref://cases/cas_9/timeline' },
    purpose: 'Preparing the case for a compliance review meeting.',
    correlationId: 'cor_1',
    ...overrides,
  });
}

function output(overrides: Record<string, unknown> = {}) {
  return assistOutputSchema.parse({
    requestId: 'air_1',
    feature: 'summarize_case',
    text: 'The case concerns three flagged transfers over two days.',
    modelId: 'model.summary',
    modelVersion: '2026-05',
    promptId: 'prompt.summarize_case',
    promptVersion: '3.1.0',
    guardrails: [{ name: 'pii', outcome: 'pass' }],
    limitReached: false,
    inputTokens: 900,
    outputTokens: 120,
    costMinorUnits: '4',
    requiresReview: false,
    reviewedBy: null,
    generatedAt: NOW,
    ...overrides,
  });
}

describe('what AI may do', () => {
  it('produces text and nothing else', () => {
    // There is no return type carrying an action, so a model cannot execute anything — there is
    // nothing to execute it through.
    const keys = Object.keys(output());

    expect(keys).toContain('text');
    for (const forbidden of ['action', 'operation', 'apiPath', 'mutation', 'execute']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('lists what it may never do, so the absence is checkable', () => {
    expect(AI_FORBIDDEN_ACTIONS).toContain('post a ledger entry');
    expect(AI_FORBIDDEN_ACTIONS).toContain('publish a financial product');
    expect(AI_FORBIDDEN_ACTIONS).toContain('execute a disaster-recovery procedure');
  });

  it('names every feature with a verb that produces words rather than changes', () => {
    /*
     * The naming rule is a review aid, not a control — the control is that no return type carries
     * an action. But a feature called `apply_classification` would read as acceptable in a diff,
     * and this refuses it at the point somebody types it.
     *
     * Every verb here produces text: suggest, analyse and detect were added with the enterprise
     * governance features and are the same shape as the original five.
     */
    for (const feature of AI_ASSIST_FEATURES) {
      expect(feature).toMatch(
        /^(summarize|explain|draft|recommend|propose|suggest|analyse|detect)_/,
      );
    }
  });
});

describe('preconditions', () => {
  it('refuses an input the feature does not take', () => {
    // Widening an assistant's inputs "so it has more context" is how a summarizer becomes a way
    // to read a record the requester cannot open.
    expect(() =>
      assertAssistPreconditions(
        request({ inputs: { caseRef: 'cas_9', customerFullRecord: 'ref://customers/cus_1' } }),
      ),
    ).toThrow(/does not take/);
  });

  it('permits exactly the declared inputs', () => {
    expect(() => assertAssistPreconditions(request())).not.toThrow();
  });

  it('declares a closed input list for every feature', () => {
    for (const feature of AI_ASSIST_FEATURES) {
      expect(PERMITTED_INPUTS[feature].length, feature).toBeGreaterThan(0);
    }
  });

  it('refuses a draft prompt version in production', () => {
    expect(() => assertAssistPreconditions(request({ promptVersion: '4.0.0-draft' }))).toThrow(
      /draft prompt/,
    );
  });

  it('requires a tenant', () => {
    expect(() => request({ organizationId: undefined })).toThrow();
  });

  it('requires an approved prompt version and a policy', () => {
    expect(() => request({ promptId: undefined })).toThrow();
    expect(() => request({ policyId: undefined })).toThrow();
  });

  it('requires a purpose long enough to be one', () => {
    expect(() => request({ purpose: 'because' })).toThrow();
  });
});

describe('using an output', () => {
  it('refuses an output a guardrail blocked', () => {
    // Showing it with a warning attached is a warning somebody reads once.
    expect(() =>
      assertOutputUsable(output({ guardrails: [{ name: 'pii', outcome: 'block' }] })),
    ).toThrow(/blocked this output/);
  });

  it('refuses a truncated output', () => {
    expect(() => assertOutputUsable(output({ limitReached: true }))).toThrow(/half a thought/);
  });

  it('refuses an unreviewed output that needs a review', () => {
    expect(() => assertOutputUsable(output({ requiresReview: true, reviewedBy: null }))).toThrow(
      /needs a person/,
    );
  });

  it('permits a reviewed one', () => {
    expect(() =>
      assertOutputUsable(output({ requiresReview: true, reviewedBy: 'usr_ai_ops' })),
    ).not.toThrow();
  });

  it('requires review for anything that reaches a customer or decides about a person', () => {
    for (const feature of [
      'draft_customer_response',
      'recommend_next_step',
      'summarize_risk_case',
      'propose_product_configuration',
    ] as const) {
      expect(requiresHumanReview(feature), feature).toBe(true);
    }

    expect(requiresHumanReview('explain_transaction_failure')).toBe(false);
  });
});

describe('the gateway request', () => {
  it('runs as the actor, not as the application', () => {
    // Tool permissions are validated against the actor, not the agent — the control that makes a
    // successful prompt injection survivable.
    const built = buildGatewayRequest(request(), 'prod');

    expect(built.actorId).toBe('usr_risk');
    expect(built.organizationId).toBe('org_a');
  });

  it('carries the prompt version and the policy', () => {
    const built = buildGatewayRequest(request(), 'prod');
    expect(built.promptVersion).toBe('3.1.0');
    expect(built.policyId).toBe('policy.internal_assist');
  });

  it('applies the precondition checks before building anything', () => {
    expect(() =>
      buildGatewayRequest(request({ inputs: { everything: 'ref://all' } }), 'prod'),
    ).toThrow();
  });
});

describe('the audit record', () => {
  it('carries provenance and counts, never the prompt or the output', () => {
    const detail = assistAuditDetail(request(), output());

    expect(detail.promptVersion).toBe('3.1.0');
    expect(detail.inputTokens).toBe(900);
    expect(detail.purpose).toContain('compliance review');

    // Where content lives is one deliberate place, and an audit trail is not it.
    expect(JSON.stringify(detail)).not.toContain('three flagged transfers');
  });

  it('records a request that produced nothing', () => {
    const detail = assistAuditDetail(request(), null);
    expect(detail.modelId).toBeNull();
    expect(detail.inputTokens).toBe(0);
  });
});

describe('the enterprise governance features', () => {
  const governanceFeatures = [
    'explain_policy',
    'explain_policy_decision',
    'suggest_data_classification',
    'draft_api_documentation',
    'summarize_slo_status',
    'draft_postmortem',
    'analyse_dr_plan',
    'detect_governance_gaps',
  ] as const;

  it('are all present', () => {
    for (const feature of governanceFeatures) {
      expect(AI_ASSIST_FEATURES).toContain(feature);
    }
  });

  it('only ever produce a proposal', () => {
    /*
     * Asserted over the whole list rather than over the ones somebody remembered. A feature added
     * later that could act would have to be added to `isProposalOnly` as an exception, in a diff a
     * reviewer sees.
     */
    for (const feature of AI_ASSIST_FEATURES) {
      expect(isProposalOnly(feature)).toBe(true);
    }
  });

  it('needs a person before a suggested classification is used', () => {
    /*
     * The sharpest of the governance features. Acting on a suggestion without review would let a
     * model lower the classification of a table, and every downstream control — masking, export,
     * reveal, retention — reads that label.
     */
    expect(requiresHumanReview('suggest_data_classification')).toBe(true);
    expect(ACTION_PERMISSION_FOR.suggest_data_classification).toBe('enterprise.data.classify');
  });

  it('does not require a reviewer for an explanation', () => {
    // It restates something the reader could have read. Requiring review for every explanation is
    // how review becomes a formality that gets clicked through.
    expect(requiresHumanReview('explain_policy')).toBe(false);
    expect(ACTION_PERMISSION_FOR.explain_policy).toBeNull();
  });

  it('gives a classification suggester field names, never field values', () => {
    /*
     * The way a suggestion feature becomes an exfiltration path is that somebody adds sample rows
     * "so it classifies better". The allow-list is what stops that being a one-line change.
     */
    const inputs = PERMITTED_INPUTS.suggest_data_classification;

    expect(inputs).toContain('fieldNames');
    expect(inputs.some((input) => input.toLowerCase().includes('value'))).toBe(false);
    expect(inputs.some((input) => input.toLowerCase().includes('sample'))).toBe(false);
    expect(inputs.some((input) => input.toLowerCase().includes('row'))).toBe(false);
  });

  it('gives a DR analyser the plan and not the credentials it references', () => {
    expect(PERMITTED_INPUTS.analyse_dr_plan).toEqual(['planId', 'planVersion']);
  });

  it('names the governance actions it may never take', () => {
    for (const forbidden of [
      'activate a policy',
      'change a data classification',
      'publish an API',
      'mark a backup validated',
      'record a restore test or a DR exercise',
      'close an incident',
    ]) {
      expect(AI_FORBIDDEN_ACTIONS).toContain(forbidden);
    }
  });

  it('maps every feature to the permission a person needs to act on it', () => {
    // Rendered as "this needs somebody with X" rather than an Apply button that fails — and the
    // permission is checked by the surface that performs the action, not by the assistant.
    for (const feature of AI_ASSIST_FEATURES) {
      expect(ACTION_PERMISSION_FOR).toHaveProperty(feature);
    }
  });
});
