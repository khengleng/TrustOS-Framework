import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  citationCoverage,
  containsExpected,
  costScore,
  excludesForbidden,
  groundedness,
  latencyScore,
  relevance,
  safetyScore,
  schemaCompliance,
} from './metrics';
import { EvaluationService, type EvaluationSuite } from './suite';
import { InMemoryEvaluationRunStore } from './testing';

/**
 * The metric tests double as documentation of what each number does *not* mean.
 *
 * The comparison tests are the ones that matter operationally: a regression must be reported per
 * case, because an average that barely moved hides the two cases that fell off a cliff.
 */

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

const suite = (overrides: Partial<EvaluationSuite> = {}) => ({
  id: 'support-answers',
  name: 'Support answers',
  subject: 'support-agent',
  latencyBudgetMs: 5000,
  costBudgetCents: 2,
  cases: [
    {
      id: 'refund-window',
      input: 'How long do I have to request a refund?',
      sources: ['Refunds may be requested within 30 days of delivery.'],
      expected: ['30 days'],
      forbidden: ['guarantee'],
      thresholds: { groundedness: 0.5 },
      note: 'The commonest question, and the one where a wrong number costs money.',
    },
  ],
  ...overrides,
});

function service(options: Record<string, unknown> = {}) {
  const store = new InMemoryEvaluationRunStore();

  const evaluation = new EvaluationService({
    store,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
    ...options,
  });

  return { store, evaluation };
}

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('groundedness', () => {
  it('scores an answer drawn from the sources highly', () => {
    const result = groundedness('Refunds may be requested within 30 days of delivery.', [
      'Refunds may be requested within 30 days of delivery.',
    ]);

    expect(result.score).toBe(1);
  });

  it('scores an answer the sources never mention low', () => {
    const result = groundedness('Contact the Phnom Penh branch manager for an exception.', [
      'Refunds may be requested within 30 days of delivery.',
    ]);

    expect(result.score).toBeLessThan(0.2);
    expect(result.detail).toMatch(/Not found:/);
  });

  it('keeps numbers, so an invented amount does not look grounded', () => {
    // Dropping numbers as noise makes "$400" and "$40" identical, which is exactly the divergence
    // worth catching.
    const result = groundedness('The refund is $400.', ['The refund is $40.']);

    expect(result.detail).toMatch(/400/);
    expect(result.score).toBeLessThan(1);
  });

  it('says plainly that it does not measure correctness', () => {
    expect(groundedness('anything at all here', ['anything at all here']).detail).toMatch(
      /not correctness/,
    );
  });

  it('scores an empty answer zero rather than dividing by nothing', () => {
    expect(groundedness('', ['a source']).score).toBe(0);
  });
});

describe('citation coverage', () => {
  it('is zero when a marker points at a source that does not exist', () => {
    // A fabricated citation means the model stopped reading its context, which is a fact rather
    // than an estimate — hence a measurement.
    const result = citationCoverage('Refunds take 30 days [4].', 2);

    expect(result.score).toBe(0);
    expect(result.kind).toBe('measurement');
    expect(result.detail).toMatch(/stopped reading its context/);
  });

  it('is zero when an answer with sources cites nothing', () => {
    expect(citationCoverage('Refunds take 30 days.', 2).score).toBe(0);
  });

  it('is one when every source is cited', () => {
    expect(citationCoverage('Refunds take 30 days [1] unless damaged [2].', 2).score).toBe(1);
  });

  it('does not punish an answer for having no citations when there were no sources', () => {
    expect(citationCoverage('Hello.', 0).score).toBe(1);
    expect(citationCoverage('Hello [1].', 0).score).toBe(0);
  });
});

describe('exact metrics', () => {
  it('reports which expected item is missing', () => {
    const result = containsExpected('You have a month to ask.', ['30 days']);

    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/Missing: 30 days/);
  });

  it('fails outright when something forbidden appears', () => {
    // Binary on purpose: "mostly did not promise a refund" is not a passing grade.
    expect(excludesForbidden('We guarantee a refund.', ['guarantee']).score).toBe(0);
    expect(excludesForbidden('We will check and let you know.', ['guarantee']).score).toBe(1);
  });

  it('scores schema compliance as pass or fail', () => {
    expect(schemaCompliance({}, () => ({ ok: true })).score).toBe(1);
    expect(
      schemaCompliance({}, () => ({ ok: false, errors: ['answer is required'] })).detail,
    ).toMatch(/answer is required/);
  });

  it('scores at-budget latency as a pass and degrades past it', () => {
    expect(latencyScore(3000, 5000).score).toBe(1);
    expect(latencyScore(5000, 5000).passed).toBe(true);
    expect(latencyScore(7500, 5000).score).toBeCloseTo(0.5, 5);
    expect(latencyScore(20_000, 5000).score).toBe(0);
  });

  it('scores cost the same way', () => {
    expect(costScore(1, 2).score).toBe(1);
    expect(costScore(3, 2).score).toBeCloseTo(0.5, 5);
    expect(costScore(0, 0).score).toBe(1);
  });

  it('takes a guardrail result rather than scanning again', () => {
    // One set of safety rules, in one place.
    expect(safetyScore({ outcome: 'allowed' }).score).toBe(1);
    expect(safetyScore({ outcome: 'needs_review' }).score).toBe(0.5);
    expect(safetyScore({ outcome: 'blocked', reasons: ['card number'] }).detail).toMatch(
      /card number/,
    );
  });

  it('treats a question with no content words as answered', () => {
    expect(relevance('anything', 'is it?').score).toBe(1);
  });
});

describe('running a suite', () => {
  it('scores a case against its thresholds', async () => {
    const { evaluation } = service();

    const run = await evaluation.run({
      suite: suite(),
      variant: 'prompt-v3',
      target: async () => ({
        output: 'Refunds may be requested within 30 days of delivery [1].',
        latencyMs: 800,
        costCents: 0.4,
      }),
    });

    expect(run).toMatchObject({ passed: 1, failed: 0, errored: 0, variant: 'prompt-v3' });
    expect(run.scores.groundedness).toBeGreaterThan(0.8);
  });

  it('fails a case that missed a threshold and says by how much', async () => {
    const { evaluation } = service();

    const run = await evaluation.run({
      suite: suite(),
      variant: 'prompt-v4',
      target: async () => ({ output: 'Ask the branch manager in Phnom Penh.' }),
    });

    expect(run.failed).toBe(1);
    expect(run.results[0]!.failures.join(' ')).toMatch(
      /groundedness scored 0\.\d+ against a threshold of 0\.50/,
    );
  });

  it('records a case that threw as errored rather than failed', async () => {
    /*
     * Different things. A failed case was measured and scored badly; an errored one was never
     * measured, so averaging it in would invent a number.
     */
    const { evaluation } = service();

    const run = await evaluation.run({
      suite: suite(),
      variant: 'broken',
      target: async () => {
        throw new Error('The gateway is unreachable.');
      },
    });

    expect(run).toMatchObject({ errored: 1, failed: 0, passed: 0 });
    expect(run.scores).toEqual({});
    expect(run.results[0]!.error).toMatch(/unreachable/);
  });

  it('keeps going after one case fails', async () => {
    const { evaluation } = service();
    let calls = 0;

    const run = await evaluation.run({
      suite: suite({
        cases: [
          {
            id: 'a',
            input: 'q',
            note: 'first',
            expected: [],
            forbidden: [],
            sources: [],
            tags: [],
            thresholds: {},
          },
          {
            id: 'b',
            input: 'q',
            note: 'second',
            expected: [],
            forbidden: [],
            sources: [],
            tags: [],
            thresholds: {},
          },
        ] as never,
      }),
      variant: 'v1',
      target: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { output: 'fine' };
      },
    });

    expect(run.results).toHaveLength(2);
    expect(run.errored).toBe(1);
  });

  it('only scores groundedness and citations when there are sources', async () => {
    const { evaluation } = service();

    const run = await evaluation.run({
      suite: suite({
        cases: [
          {
            id: 'no-sources',
            input: 'Say hello.',
            note: 'A case with no retrieval.',
            sources: [],
            expected: [],
            forbidden: [],
            tags: [],
            thresholds: {},
          },
        ] as never,
      }),
      variant: 'v1',
      target: async () => ({ output: 'Hello.' }),
    });

    expect(Object.keys(run.scores)).not.toContain('groundedness');
    expect(Object.keys(run.scores)).not.toContain('citation_coverage');
  });

  it('uses a model grader when one is supplied', async () => {
    // The framework ships no grader: a grader is a model call and a prompt, and both belong to
    // the deployment.
    const modelGrader = vi.fn(async () => ({ score: 0.9, detail: 'Accurate and complete.' }));
    const { evaluation } = service({ modelGrader });

    const run = await evaluation.run({
      suite: suite(),
      variant: 'v1',
      target: async () => ({ output: 'Refunds take 30 days [1].' }),
    });

    expect(modelGrader).toHaveBeenCalledOnce();
    expect(run.scores.model_graded).toBe(0.9);
  });
});

describe('comparison', () => {
  const runWith = async (evaluation: EvaluationService, output: string, variant: string) =>
    evaluation.run({
      suite: suite({
        cases: [
          {
            id: 'refund-window',
            input: 'How long do I have to request a refund?',
            sources: ['Refunds may be requested within 30 days of delivery.'],
            expected: ['30 days'],
            forbidden: [],
            thresholds: { groundedness: 0.5 },
            tags: [],
            note: 'x',
          },
          {
            id: 'damaged',
            input: 'What if the item arrived damaged?',
            sources: ['A damaged item may be returned at any time.'],
            expected: ['damaged'],
            forbidden: [],
            thresholds: { groundedness: 0.5 },
            tags: [],
            note: 'y',
          },
        ] as never,
      }),
      variant,
      target: async ({ case: entry }) => ({
        output:
          entry.id === 'refund-window' ? output : 'A damaged item may be returned at any time.',
      }),
    });

  it('names the case that regressed, not just the average', async () => {
    const { evaluation } = service();

    const baseline = await runWith(
      evaluation,
      'Refunds may be requested within 30 days of delivery.',
      'v1',
    );
    clock = new Date(clock.getTime() + 1000);
    const candidate = await runWith(evaluation, 'Please contact the branch manager.', 'v2');

    const comparison = evaluation.compare(baseline, candidate);

    expect(comparison.verdict).toBe('worse');
    expect(comparison.newFailures).toEqual(['refund-window']);
    expect(comparison.regressions.map((entry) => entry.caseId)).toContain('refund-window');
    // The unchanged case is not reported as either.
    expect(comparison.regressions.every((entry) => entry.caseId !== 'damaged')).toBe(true);
  });

  it('ignores movement inside the tolerance', async () => {
    // A non-deterministic model moves a score slightly on every run. Reporting that as a
    // regression trains everybody to ignore the report.
    const { evaluation } = service();

    const baseline = await runWith(evaluation, 'Refunds may be requested within 30 days.', 'v1');
    clock = new Date(clock.getTime() + 1000);
    const candidate = await runWith(
      evaluation,
      'Refunds may be requested within 30 days of delivery.',
      'v2',
    );

    expect(evaluation.compare(baseline, candidate, { tolerance: 0.5 }).regressions).toEqual([]);
  });

  it('refuses to compare runs of different suites', async () => {
    const { evaluation } = service();

    const first = await evaluation.run({
      suite: suite(),
      variant: 'v1',
      target: async () => ({ output: 'x' }),
    });

    const second = await evaluation.run({
      suite: suite({ id: 'other-suite' }),
      variant: 'v1',
      target: async () => ({ output: 'x' }),
    });

    expect(() => evaluation.compare(first, second)).toThrow(/cannot be compared/);
  });

  it('says incomparable when the runs share no cases', async () => {
    const { evaluation } = service();

    const first = await evaluation.run({
      suite: suite(),
      variant: 'v1',
      target: async () => ({ output: 'x' }),
    });

    const second = await evaluation.run({
      suite: suite({
        cases: [
          {
            id: 'brand-new',
            input: 'q',
            note: 'n',
            sources: [],
            expected: [],
            forbidden: [],
            tags: [],
            thresholds: {},
          },
        ] as never,
      }),
      variant: 'v2',
      target: async () => ({ output: 'x' }),
    });

    expect(evaluation.compare(first, second).verdict).toBe('incomparable');
  });

  it('compares against the previous run automatically', async () => {
    const { evaluation } = service();

    const first = await evaluation.runAndCompare({
      suite: suite(),
      variant: 'v1',
      target: async () => ({ output: 'Refunds may be requested within 30 days of delivery [1].' }),
    });

    expect(first.comparison).toBeNull();

    clock = new Date(clock.getTime() + 1000);

    const second = await evaluation.runAndCompare({
      suite: suite(),
      variant: 'v2',
      target: async () => ({ output: 'Ask a manager.' }),
    });

    expect(second.comparison!.verdict).toBe('worse');
  });
});

describe('summarise', () => {
  it('reports the failures with their reasons', async () => {
    const { evaluation } = service();

    const run = await evaluation.run({
      suite: suite(),
      variant: 'v9',
      target: async () => ({ output: 'Ask a manager.' }),
    });

    const summary = evaluation.summarise(run);

    expect(summary).toMatch(/support-answers — v9/);
    expect(summary).toMatch(/0 passed, 1 failed/);
    expect(summary).toMatch(/refund-window: groundedness scored/);
  });
});
