import { z } from 'zod';

/**
 * Evaluation metrics.
 *
 * **What these numbers are, and what they are not.** Every metric here is a heuristic computed
 * from text. `groundedness` measures how much of an answer's vocabulary appears in the sources it
 * was given; it detects an answer that wandered away from its context, and it does *not* detect
 * one that is fluently wrong about something the sources also got wrong. `relevance` compares the
 * answer to the question the same way. Neither measures truth, and a package that reported them
 * as "accuracy" would be lying in a way that is very hard to notice — the number looks fine.
 *
 * They are useful for exactly one thing, which is worth a great deal: **detecting change**. A
 * groundedness of 0.62 means little on its own. A groundedness that was 0.81 last week and is 0.62
 * today means somebody changed a prompt, and that is a question worth asking.
 *
 * The metrics that *are* exact say so: `schemaCompliance`, `citationCoverage`, `latency`, `cost`.
 * Those are measurements. The rest are signals.
 *
 * Anything needing real judgement — is this answer correct, is it appropriate, is the tone right —
 * is a `model_graded` or `human` metric, supplied by the caller as a port. The framework does not
 * ship a grader, because a grader is a model call and a prompt, and both belong to the deployment.
 */

export const METRIC_KINDS = [
  /** Computed from text. Cheap, deterministic, approximate. */
  'heuristic',
  /** Measured. Exact. */
  'measurement',
  /** Scored by a model. Needs a port. */
  'model_graded',
  /** Scored by a person. Needs a port, usually `@trustsystem/human-review`. */
  'human',
] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export const metricResultSchema = z
  .object({
    name: z.string().min(1).max(60),
    kind: z.enum(METRIC_KINDS),
    /** 0 to 1, higher is better. Normalised so a suite can average across metrics. */
    score: z.number().min(0).max(1),
    /** The raw value, when the score is a normalisation of something else (ms, cents). */
    raw: z.number().nullable().default(null),
    /** Whether this met its threshold. Null when no threshold was set. */
    passed: z.boolean().nullable().default(null),
    /** What the score means, in words. Shown next to the number. */
    detail: z.string().max(2000).default(''),
  })
  .strict();

export type MetricResult = z.infer<typeof metricResultSchema>;

/** Words too common to carry meaning. Left out of overlap scoring. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'as',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
  'i',
  'he',
  'she',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'not',
  'no',
  'yes',
  'can',
  'could',
  'will',
  'would',
  'should',
  'may',
  'might',
  'must',
  'there',
  'here',
  'what',
  'which',
  'who',
  'when',
  'where',
  'how',
  'why',
  'all',
  'any',
  'some',
  'more',
  'most',
  'other',
  'than',
  'so',
  'up',
  'out',
  'about',
]);

/**
 * Content words, lowercased.
 *
 * Numbers are kept — "$40" and "$400" differing is exactly the kind of divergence worth catching,
 * and dropping them makes an answer that invented an amount look perfectly grounded.
 */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.$%-]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[.$%-]+|[.$%-]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * How much of the answer is supported by the sources.
 *
 * The fraction of the answer's content words that appear in the provided context. **This is not a
 * hallucination detector**, and the difference matters: an answer that copies a sentence from a
 * source scores 1.0 whether or not the source is right, and an answer that correctly paraphrases
 * scores lower than one that parrots.
 *
 * What it reliably catches is an answer that went somewhere the sources never mentioned. That is
 * the common RAG failure, so it is worth measuring — under an honest name.
 */
export function groundedness(answer: string, sources: string[]): MetricResult {
  const answerTokens = contentTokens(answer);

  if (answerTokens.length === 0) {
    return metricResultSchema.parse({
      name: 'groundedness',
      kind: 'heuristic',
      score: 0,
      detail: 'The answer has no content words to check.',
    });
  }

  const supported = new Set(sources.flatMap((source) => contentTokens(source)));
  const matched = answerTokens.filter((token) => supported.has(token));
  const unsupported = [...new Set(answerTokens.filter((token) => !supported.has(token)))];

  const score = matched.length / answerTokens.length;

  return metricResultSchema.parse({
    name: 'groundedness',
    kind: 'heuristic',
    score,
    raw: matched.length,
    detail:
      `${matched.length} of ${answerTokens.length} content words appear in the sources. ` +
      (unsupported.length > 0
        ? `Not found: ${unsupported.slice(0, 12).join(', ')}${unsupported.length > 12 ? ', …' : ''}. `
        : '') +
      'This measures overlap with the sources, not correctness.',
  });
}

/** How much of the question the answer engages with. Same caveat as groundedness. */
export function relevance(answer: string, question: string): MetricResult {
  const questionTokens = [...new Set(contentTokens(question))];

  if (questionTokens.length === 0) {
    return metricResultSchema.parse({
      name: 'relevance',
      kind: 'heuristic',
      score: 1,
      detail: 'The question has no content words to check against.',
    });
  }

  const answerTokens = new Set(contentTokens(answer));
  const covered = questionTokens.filter((token) => answerTokens.has(token));

  return metricResultSchema.parse({
    name: 'relevance',
    kind: 'heuristic',
    score: covered.length / questionTokens.length,
    raw: covered.length,
    detail: `The answer mentions ${covered.length} of the question's ${questionTokens.length} content words.`,
  });
}

/**
 * Whether the answer cites, and whether every marker it used exists.
 *
 * A **measurement**, not a heuristic: a `[4]` when three sources were supplied is a fabricated
 * citation, and that is a fact rather than an estimate. It is also the most useful single signal
 * in a RAG system, because a model that invents a citation marker has stopped reading its context.
 */
export function citationCoverage(answer: string, sourceCount: number): MetricResult {
  const markers = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  const unique = [...new Set(markers)];
  const fabricated = unique.filter((marker) => marker < 1 || marker > sourceCount);

  if (sourceCount === 0) {
    return metricResultSchema.parse({
      name: 'citation_coverage',
      kind: 'measurement',
      score: markers.length === 0 ? 1 : 0,
      raw: markers.length,
      detail:
        markers.length === 0
          ? 'No sources and no citations, which is consistent.'
          : `The answer cites ${markers.length} source(s) but none were supplied.`,
    });
  }

  if (fabricated.length > 0) {
    return metricResultSchema.parse({
      name: 'citation_coverage',
      kind: 'measurement',
      score: 0,
      raw: fabricated.length,
      detail:
        `The answer cites ${fabricated.map((marker) => `[${marker}]`).join(', ')}, but only ` +
        `${sourceCount} source(s) were supplied. A fabricated citation means the model stopped ` +
        'reading its context.',
    });
  }

  return metricResultSchema.parse({
    name: 'citation_coverage',
    kind: 'measurement',
    score: unique.length === 0 ? 0 : Math.min(1, unique.length / sourceCount),
    raw: unique.length,
    detail:
      unique.length === 0
        ? 'The answer cites nothing, so no claim can be traced to a source.'
        : `The answer cites ${unique.length} of ${sourceCount} source(s), all of which exist.`,
  });
}

/**
 * Whether the output matches the schema that was asked for.
 *
 * A measurement, and a binary one. Partial schema compliance is not a useful number — the object
 * either parses into what the caller expects or it does not.
 */
export function schemaCompliance(
  output: unknown,
  validate: (value: unknown) => { ok: boolean; errors?: string[] },
): MetricResult {
  const result = validate(output);

  return metricResultSchema.parse({
    name: 'schema_compliance',
    kind: 'measurement',
    score: result.ok ? 1 : 0,
    passed: result.ok,
    detail: result.ok
      ? 'The output matches the requested schema.'
      : `The output does not match: ${(result.errors ?? ['no detail']).slice(0, 5).join('; ')}.`,
  });
}

/**
 * Latency against a budget.
 *
 * Normalised so that at or under budget is 1 and twice the budget is 0, because a suite averaging
 * "3200" with "0.81" produces a number that means nothing.
 */
export function latencyScore(latencyMs: number, budgetMs: number): MetricResult {
  const score = Math.max(0, Math.min(1, 2 - latencyMs / Math.max(1, budgetMs)));

  return metricResultSchema.parse({
    name: 'latency',
    kind: 'measurement',
    score: latencyMs <= budgetMs ? 1 : score,
    raw: latencyMs,
    passed: latencyMs <= budgetMs,
    detail: `${latencyMs}ms against a ${budgetMs}ms budget.`,
  });
}

/** Cost against a budget, in cents. Same normalisation as latency. */
export function costScore(costCents: number, budgetCents: number): MetricResult {
  const score = Math.max(0, Math.min(1, 2 - costCents / Math.max(0.0001, budgetCents)));

  return metricResultSchema.parse({
    name: 'cost',
    kind: 'measurement',
    score: costCents <= budgetCents ? 1 : score,
    raw: costCents,
    passed: costCents <= budgetCents,
    detail: `${costCents.toFixed(4)}c against a ${budgetCents}c budget.`,
  });
}

/**
 * Whether the expected answer's key facts survived.
 *
 * For a suite with known answers. Checks that specific strings are present, which is a blunt test
 * that happens to catch the failure that matters: a change to a prompt that stops the model
 * mentioning the fee, the deadline or the refusal it is supposed to mention.
 */
export function containsExpected(answer: string, expected: string[]): MetricResult {
  if (expected.length === 0) {
    return metricResultSchema.parse({
      name: 'expected_content',
      kind: 'measurement',
      score: 1,
      detail: 'Nothing specific was expected.',
    });
  }

  const lower = answer.toLowerCase();
  const missing = expected.filter((item) => !lower.includes(item.toLowerCase()));

  return metricResultSchema.parse({
    name: 'expected_content',
    kind: 'measurement',
    score: (expected.length - missing.length) / expected.length,
    raw: expected.length - missing.length,
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `All ${expected.length} expected item(s) are present.`
        : `Missing: ${missing.join(', ')}.`,
  });
}

/**
 * Whether anything forbidden appeared.
 *
 * The mirror of `containsExpected`, and the more important half. "Never state an account number",
 * "never promise a refund", "never say 'as an AI'" — a suite that only checks for the right things
 * does not notice the wrong ones arriving.
 */
export function excludesForbidden(answer: string, forbidden: string[]): MetricResult {
  const lower = answer.toLowerCase();
  const found = forbidden.filter((item) => lower.includes(item.toLowerCase()));

  return metricResultSchema.parse({
    name: 'forbidden_content',
    kind: 'measurement',
    score: found.length === 0 ? 1 : 0,
    raw: found.length,
    passed: found.length === 0,
    detail:
      found.length === 0
        ? 'Nothing forbidden appeared.'
        : `Found what should not be there: ${found.join(', ')}.`,
  });
}

/**
 * Safety, from a guardrail scan.
 *
 * Takes the result rather than doing the scanning, so evaluation does not become a second place
 * where safety rules live. One set of rules, one implementation, in `@trustsystem/guardrails`.
 */
export function safetyScore(scan: {
  outcome: 'allowed' | 'blocked' | 'needs_review';
  reasons?: string[];
}): MetricResult {
  const score = scan.outcome === 'allowed' ? 1 : scan.outcome === 'needs_review' ? 0.5 : 0;

  return metricResultSchema.parse({
    name: 'safety',
    kind: 'measurement',
    score,
    passed: scan.outcome === 'allowed',
    detail:
      scan.outcome === 'allowed'
        ? 'The guardrails allowed this output.'
        : `The guardrails returned ${scan.outcome}: ${(scan.reasons ?? []).join('; ') || 'no detail'}.`,
  });
}
