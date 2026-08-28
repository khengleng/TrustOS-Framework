import { z } from 'zod';

/**
 * Risk-category signals.
 *
 * **These are keyword signals, not a classifier.** The distinction matters enough to put in the
 * first line: a keyword match will flag a discussion *about* violence as readily as a threat, and
 * will miss anything phrased carefully. Treating the output as a verdict produces both false
 * accusations and false comfort.
 *
 * What they are useful for:
 *
 *   * **Routing to human review.** A flag on a medical-advice signal is a good reason for a person
 *     to read the output before a customer does.
 *   * **An audit trail.** "This response was flagged for financial advice and approved by X" is a
 *     record somebody can defend.
 *   * **A cheap first pass** in front of a real classifier, where a deployment has one. The
 *     `CategoryClassifier` port is where that plugs in.
 *
 * What they are not useful for: deciding, alone, that content is unsafe.
 */

export const RISK_CATEGORIES = [
  'hate',
  'violence',
  'sexual',
  'self_harm',
  'harassment',
  /** Advice that could cause financial loss if wrong. */
  'financial_advice',
  /** Advice that could cause harm if wrong. */
  'medical_advice',
  'legal_advice',
  'profanity',
  /** Claims about the system's own capabilities or authority. */
  'unauthorised_commitment',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const CATEGORY_SEVERITIES = ['none', 'low', 'medium', 'high'] as const;
export type CategorySeverity = (typeof CATEGORY_SEVERITIES)[number];

export interface CategorySignal {
  category: RiskCategory;
  severity: CategorySeverity;
  /** What matched. Deliberately short. */
  excerpt: string;
  /**
   * Always present, and always says this is a signal.
   *
   * Carried into the review UI, so the person deciding sees the caveat rather than a bare label
   * that reads as a verdict.
   */
  caveat: string;
}

/** A real classifier, where a deployment has one. The framework ships none. */
export interface CategoryClassifier {
  readonly name: string;
  classify(text: string): Promise<CategorySignal[]>;
}

interface CategoryRule {
  category: RiskCategory;
  severity: CategorySeverity;
  terms: RegExp;
}

/**
 * The rules.
 *
 * Word-boundary matches on small term sets. Not exhaustive and not trying to be — an exhaustive
 * keyword list is a list that flags every clinical document as medical advice.
 *
 * The advice categories are the most useful of these in an enterprise setting, and the least
 * discussed: an assistant that tells a customer their loan will be approved has made a commitment
 * the business has to honour or explain.
 */
const RULES: CategoryRule[] = [
  {
    category: 'financial_advice',
    severity: 'medium',
    terms:
      /\b(?:you should invest|guaranteed return|risk-free|will definitely (?:appreciate|profit|increase)|i recommend (?:buying|selling)|this is financial advice)\b/i,
  },
  {
    category: 'medical_advice',
    severity: 'high',
    terms:
      /\b(?:you should take|stop taking|increase your dose|diagnos(?:e|is) (?:is|of)|you (?:have|are suffering from) (?:a|an)? ?(?:condition|disease|disorder))\b/i,
  },
  {
    category: 'legal_advice',
    severity: 'medium',
    terms:
      /\b(?:you (?:should|must) sue|this is (?:not )?legally binding|you are (?:not )?liable|constitutes a breach)\b/i,
  },
  {
    category: 'unauthorised_commitment',
    severity: 'high',
    terms:
      /\b(?:i (?:can|will) (?:guarantee|promise|approve|authorise|authorize|waive|refund)|your (?:refund|claim|application) (?:is|has been) approved|we will definitely)\b/i,
  },
  {
    category: 'self_harm',
    severity: 'high',
    terms:
      /\b(?:kill (?:myself|yourself)|end (?:my|your) life|suicide method|how to (?:die|hurt myself))\b/i,
  },
  {
    category: 'violence',
    severity: 'high',
    terms:
      /\b(?:how to (?:make|build) (?:a )?(?:bomb|weapon|explosive)|kill (?:him|her|them)|hurt (?:him|her|them) badly)\b/i,
  },
  {
    category: 'hate',
    severity: 'high',
    terms:
      /\b(?:all (?:\w+) (?:are|should be) (?:killed|deported|eliminated)|inferior race|subhuman)\b/i,
  },
  {
    category: 'harassment',
    severity: 'medium',
    terms: /\b(?:you(?:'re| are) (?:an? )?(?:idiot|moron|worthless|pathetic)|shut up)\b/i,
  },
  {
    category: 'profanity',
    severity: 'low',
    terms: /\b(?:fuck|shit|bastard|bitch)\w*\b/i,
  },
];

const SEVERITY_ORDER: Record<CategorySeverity, number> = { none: 0, low: 1, medium: 2, high: 3 };

const CAVEAT =
  'This is a keyword signal, not a classification. It flags text for a person to read; it does ' +
  'not decide that the text is unsafe.';

export const categoryPolicySchema = z
  .object({
    /** Categories to check. Empty means all. */
    categories: z.array(z.enum(RISK_CATEGORIES)).default([]),
    /** Signals at or above this route the output to human review. */
    reviewAt: z.enum(['low', 'medium', 'high']).default('high'),
    /** Signals at or above this block outright. `none` disables blocking. */
    blockAt: z.enum(['none', 'low', 'medium', 'high']).default('none'),
    ignore: z.array(z.enum(RISK_CATEGORIES)).default([]),
  })
  .strict();

export type CategoryPolicy = z.infer<typeof categoryPolicySchema>;

export interface CategoryScan {
  severity: CategorySeverity;
  signals: CategorySignal[];
  /** Whether this should go to a human before it goes to a customer. */
  needsReview: boolean;
  blocked: boolean;
}

export function scanCategories(
  text: string,
  policy: CategoryPolicy = categoryPolicySchema.parse({}),
): CategoryScan {
  const ignore = new Set(policy.ignore);
  const only = new Set(policy.categories);
  const signals: CategorySignal[] = [];

  for (const rule of RULES) {
    if (ignore.has(rule.category)) continue;
    if (only.size > 0 && !only.has(rule.category)) continue;

    const match = rule.terms.exec(text);
    if (!match) continue;

    signals.push({
      category: rule.category,
      severity: rule.severity,
      excerpt: match[0].slice(0, 80),
      caveat: CAVEAT,
    });
  }

  const severity = signals.reduce<CategorySeverity>(
    (worst, signal) =>
      SEVERITY_ORDER[signal.severity] > SEVERITY_ORDER[worst] ? signal.severity : worst,
    'none',
  );

  return {
    severity,
    signals: signals.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]),
    needsReview: SEVERITY_ORDER[severity] >= SEVERITY_ORDER[policy.reviewAt],
    // `none` as a threshold means never block: `SEVERITY_ORDER.none` is 0 and a scan with no
    // signals is also 0, so the comparison must exclude that case explicitly.
    blocked:
      policy.blockAt !== 'none' && SEVERITY_ORDER[severity] >= SEVERITY_ORDER[policy.blockAt],
  };
}

/** Combines the keyword pass with a real classifier, where one is configured. */
export async function scanCategoriesWith(
  text: string,
  classifier: CategoryClassifier | undefined,
  policy: CategoryPolicy = categoryPolicySchema.parse({}),
): Promise<CategoryScan & { classifier: string | null }> {
  const keyword = scanCategories(text, policy);

  if (!classifier) return { ...keyword, classifier: null };

  let classified: CategorySignal[] = [];

  try {
    classified = await classifier.classify(text);
  } catch {
    /*
     * A classifier failure does not fail the request.
     *
     * The keyword pass still ran, and blocking every AI response because a classification service
     * is down would turn its outage into a total one. The absent classifier shows in the result.
     */
    return { ...keyword, classifier: null };
  }

  const signals = [...keyword.signals, ...classified];
  const severity = signals.reduce<CategorySeverity>(
    (worst, signal) =>
      SEVERITY_ORDER[signal.severity] > SEVERITY_ORDER[worst] ? signal.severity : worst,
    'none',
  );

  return {
    severity,
    signals: signals.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]),
    needsReview: SEVERITY_ORDER[severity] >= SEVERITY_ORDER[policy.reviewAt],
    blocked:
      policy.blockAt !== 'none' && SEVERITY_ORDER[severity] >= SEVERITY_ORDER[policy.blockAt],
    classifier: classifier.name,
  };
}

/** The rule catalogue, for documentation and for a tenant configuring exceptions. */
export function describeCategories(): Array<{
  category: RiskCategory;
  severity: CategorySeverity;
}> {
  return RULES.map((rule) => ({ category: rule.category, severity: rule.severity })).sort((a, b) =>
    a.category.localeCompare(b.category),
  );
}
