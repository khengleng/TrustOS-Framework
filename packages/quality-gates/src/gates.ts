import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { validateArchitecture, type SourceFile } from '@trustos/architecture-validator';

/**
 * Quality gates.
 *
 * Eleven gates a change clears before it ships. The framework's opinion, stated once, is about
 * *which* of them may be waived and by whom:
 *
 *   * **Architecture, security and testing are blocking and cannot be waived.** A waiver on a
 *     security gate is a security gate that does not exist — the first time it fires under
 *     deadline pressure, the waiver is used, and then it is always used.
 *   * **Coverage, docs, lint, format, OpenAPI, configuration and accessibility are blocking but
 *     waivable**, with a recorded reason and an expiry. A waiver with no expiry is a permanent
 *     exemption written in the language of a temporary one.
 *   * **Performance is advisory.** A performance number from CI is a number from a shared machine,
 *     and failing a build on it teaches people to re-run until it passes.
 *
 * The gates themselves do not run tools. Each takes the *result* of a tool — a coverage
 * percentage, a lint count — because a gate that shells out is a gate that behaves differently in
 * CI, on a laptop, and in the pre-commit hook.
 */

export const GATE_IDS = [
  'architecture',
  'security',
  'testing',
  'coverage',
  'documentation',
  'lint',
  'formatting',
  'openapi',
  'configuration',
  'accessibility',
  'performance',
] as const;

export type GateId = (typeof GATE_IDS)[number];

/** The three that cannot be waived. See the header. */
export const UNWAIVABLE_GATES: readonly GateId[] = ['architecture', 'security', 'testing'];

/** The one that never blocks. */
export const ADVISORY_GATES: readonly GateId[] = ['performance'];

export type GateStatus = 'pass' | 'fail' | 'waived' | 'skipped';

export interface GateResult {
  gate: GateId;
  status: GateStatus;
  detail: string;
  /** Numbers behind the verdict, for a trend. */
  measurements?: Record<string, number>;
  remediation?: string;
}

export const waiverSchema = z
  .object({
    gate: z.enum(GATE_IDS),
    reason: z.string().min(10).max(400),
    /** Who signed it off. A waiver nobody owns is a waiver nobody revisits. */
    approvedBy: z.string().min(1).max(120),
    /** ISO date. Required — see the header. */
    expiresAt: z.string().min(10).max(40),
  })
  .strict()
  .superRefine((waiver, ctx) => {
    if (UNWAIVABLE_GATES.includes(waiver.gate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gate'],
        message:
          `The ${waiver.gate} gate cannot be waived. A waiver on it is a gate that does not ` +
          'exist — the first time it fires under deadline pressure it is used, and then it always is.',
      });
    }
  });

export type Waiver = z.infer<typeof waiverSchema>;

export interface GateInput {
  /** Source files, for the architecture and security gates. */
  files?: readonly SourceFile[];
  declaredDependencies?: Readonly<Record<string, readonly string[]>>;
  /** Results from the tools that already run in CI. */
  tests?: { passed: number; failed: number; skipped?: number };
  coverage?: { lines: number; branches?: number };
  lint?: { errors: number; warnings: number };
  formatting?: { unformattedFiles: number };
  documentation?: { publicSymbols: number; documented: number; missingPages?: string[] };
  openapi?: { operations: number; undocumented: number; valid: boolean };
  configuration?: { required: string[]; present: string[] };
  accessibility?: { violations: number; serious: number };
  performance?: { budgetMs: number; measuredMs: number; label?: string };
  waivers?: readonly Waiver[];
  now?: Date;
}

export interface QualityReport {
  results: GateResult[];
  /** False when any blocking gate failed. Advisory failures never set it. */
  passed: boolean;
  blocking: GateResult[];
  waived: GateResult[];
}

/** The minimum line coverage a change must hold. */
export const COVERAGE_FLOOR = 80;

export function runQualityGates(input: GateInput): QualityReport {
  const now = input.now ?? new Date();
  const waivers = activeWaivers(input.waivers ?? [], now);
  const results: GateResult[] = [];

  results.push(architectureGate(input));
  results.push(securityGate(input));
  results.push(testingGate(input));
  results.push(coverageGate(input));
  results.push(documentationGate(input));
  results.push(lintGate(input));
  results.push(formattingGate(input));
  results.push(openapiGate(input));
  results.push(configurationGate(input));
  results.push(accessibilityGate(input));
  results.push(performanceGate(input));

  const applied = results.map((result) => {
    if (result.status !== 'fail') return result;

    const waiver = waivers.get(result.gate);
    if (!waiver) return result;

    return {
      ...result,
      status: 'waived' as const,
      detail: `${result.detail} Waived by ${waiver.approvedBy} until ${waiver.expiresAt.slice(0, 10)}: ${waiver.reason}`,
    };
  });

  const blocking = applied.filter(
    (result) => result.status === 'fail' && !ADVISORY_GATES.includes(result.gate),
  );

  return {
    results: applied,
    passed: blocking.length === 0,
    blocking,
    waived: applied.filter((result) => result.status === 'waived'),
  };
}

/**
 * Waivers that have not expired.
 *
 * An expired waiver is simply absent, so the gate fails again. That is the whole mechanism: a
 * waiver buys time, and when the time is up the problem is back rather than forgotten.
 */
function activeWaivers(waivers: readonly Waiver[], now: Date): Map<GateId, Waiver> {
  const active = new Map<GateId, Waiver>();
  const today = now.toISOString().slice(0, 10);

  for (const waiver of waivers) {
    const parsed = waiverSchema.parse(waiver);
    if (parsed.expiresAt.slice(0, 10) >= today) active.set(parsed.gate, parsed);
  }

  return active;
}

const skipped = (gate: GateId, what: string): GateResult => ({
  gate,
  status: 'skipped',
  detail: `No ${what} supplied, so this gate did not run.`,
});

function architectureGate(input: GateInput): GateResult {
  if (!input.files) return skipped('architecture', 'source files');

  const report = validateArchitecture({
    files: input.files,
    declaredDependencies: input.declaredDependencies,
  });

  const errors = report.violations.filter(
    (violation) => violation.severity === 'error' && violation.kind !== 'security',
  );

  return errors.length === 0
    ? {
        gate: 'architecture',
        status: 'pass',
        detail: `${report.filesChecked} file(s), no layering or dependency violations.`,
        measurements: { filesChecked: report.filesChecked },
      }
    : {
        gate: 'architecture',
        status: 'fail',
        detail: `${errors.length} violation(s): ${errors
          .slice(0, 3)
          .map((violation) => `${violation.file}:${violation.line} ${violation.ruleId}`)
          .join(', ')}${errors.length > 3 ? ', …' : ''}.`,
        measurements: { violations: errors.length },
        remediation: 'Run `trustos architecture-check` for the full list and the fix for each.',
      };
}

function securityGate(input: GateInput): GateResult {
  if (!input.files) return skipped('security', 'source files');

  const report = validateArchitecture({ files: input.files });
  const security = report.violations.filter((violation) => violation.kind === 'security');

  return security.length === 0
    ? { gate: 'security', status: 'pass', detail: 'No security rule violated.' }
    : {
        gate: 'security',
        status: 'fail',
        detail: `${security.length} security violation(s): ${security
          .slice(0, 3)
          .map((violation) => `${violation.file}:${violation.line} ${violation.ruleId}`)
          .join(', ')}.`,
        measurements: { violations: security.length },
        remediation: 'This gate cannot be waived. Fix each one.',
      };
}

function testingGate(input: GateInput): GateResult {
  if (!input.tests) return skipped('testing', 'test results');

  const { passed, failed } = input.tests;

  if (failed > 0) {
    return {
      gate: 'testing',
      status: 'fail',
      detail: `${failed} test(s) failing.`,
      measurements: { passed, failed },
      remediation: 'This gate cannot be waived.',
    };
  }

  if (passed === 0) {
    /*
     * Zero tests passing is not success. A suite that runs nothing reports green, and a change
     * that deletes the tests it breaks passes every other gate.
     */
    return {
      gate: 'testing',
      status: 'fail',
      detail: 'No tests ran. A suite that runs nothing reports green.',
      measurements: { passed, failed },
    };
  }

  return {
    gate: 'testing',
    status: 'pass',
    detail: `${passed} test(s) passing.`,
    measurements: { passed, failed },
  };
}

function coverageGate(input: GateInput): GateResult {
  if (!input.coverage) return skipped('coverage', 'coverage data');

  const { lines } = input.coverage;

  return lines >= COVERAGE_FLOOR
    ? {
        gate: 'coverage',
        status: 'pass',
        detail: `${lines}% line coverage, at or above the ${COVERAGE_FLOOR}% floor.`,
        measurements: { lines },
      }
    : {
        gate: 'coverage',
        status: 'fail',
        detail: `${lines}% line coverage is below the ${COVERAGE_FLOOR}% floor.`,
        measurements: { lines },
        remediation: 'Add tests for the uncovered paths, or waive with a reason and an expiry.',
      };
}

function documentationGate(input: GateInput): GateResult {
  if (!input.documentation) return skipped('documentation', 'documentation data');

  const { publicSymbols, documented, missingPages = [] } = input.documentation;
  const ratio = publicSymbols === 0 ? 100 : Math.round((documented / publicSymbols) * 100);

  if (missingPages.length > 0) {
    return {
      gate: 'documentation',
      status: 'fail',
      detail: `Missing documentation page(s): ${missingPages.join(', ')}.`,
      measurements: { ratio },
    };
  }

  return ratio >= 90
    ? {
        gate: 'documentation',
        status: 'pass',
        detail: `${ratio}% of public symbols documented.`,
        measurements: { ratio },
      }
    : {
        gate: 'documentation',
        status: 'fail',
        detail: `${ratio}% of ${publicSymbols} public symbol(s) documented.`,
        measurements: { ratio },
        remediation:
          'Document the exported surface. An undocumented export is a contract nobody agreed to.',
      };
}

function lintGate(input: GateInput): GateResult {
  if (!input.lint) return skipped('lint', 'lint results');

  return input.lint.errors === 0
    ? {
        gate: 'lint',
        status: 'pass',
        detail: `0 errors, ${input.lint.warnings} warning(s).`,
        measurements: { errors: 0, warnings: input.lint.warnings },
      }
    : {
        gate: 'lint',
        status: 'fail',
        detail: `${input.lint.errors} lint error(s).`,
        measurements: { errors: input.lint.errors, warnings: input.lint.warnings },
      };
}

function formattingGate(input: GateInput): GateResult {
  if (!input.formatting) return skipped('formatting', 'formatting results');

  return input.formatting.unformattedFiles === 0
    ? { gate: 'formatting', status: 'pass', detail: 'All files formatted.' }
    : {
        gate: 'formatting',
        status: 'fail',
        detail: `${input.formatting.unformattedFiles} file(s) not formatted.`,
        remediation: 'Run `npm run format`.',
      };
}

function openapiGate(input: GateInput): GateResult {
  if (!input.openapi) return skipped('openapi', 'OpenAPI data');

  if (!input.openapi.valid) {
    return { gate: 'openapi', status: 'fail', detail: 'The OpenAPI document does not validate.' };
  }

  return input.openapi.undocumented === 0
    ? {
        gate: 'openapi',
        status: 'pass',
        detail: `${input.openapi.operations} operation(s), all documented.`,
        measurements: { operations: input.openapi.operations },
      }
    : {
        gate: 'openapi',
        status: 'fail',
        detail: `${input.openapi.undocumented} of ${input.openapi.operations} operation(s) undocumented.`,
        measurements: { undocumented: input.openapi.undocumented },
      };
}

function configurationGate(input: GateInput): GateResult {
  if (!input.configuration) return skipped('configuration', 'configuration data');

  const missing = input.configuration.required.filter(
    (key) => !input.configuration!.present.includes(key),
  );

  return missing.length === 0
    ? { gate: 'configuration', status: 'pass', detail: 'Every required setting is documented.' }
    : {
        gate: 'configuration',
        status: 'fail',
        detail: `Undocumented required setting(s): ${missing.join(', ')}.`,
        remediation:
          'Add them to .env.example. A required variable nobody documents is a failed deployment.',
      };
}

function accessibilityGate(input: GateInput): GateResult {
  if (!input.accessibility) return skipped('accessibility', 'accessibility results');

  return input.accessibility.serious === 0
    ? {
        gate: 'accessibility',
        status: 'pass',
        detail: `${input.accessibility.violations} minor issue(s), none serious.`,
        measurements: { violations: input.accessibility.violations },
      }
    : {
        gate: 'accessibility',
        status: 'fail',
        detail: `${input.accessibility.serious} serious accessibility violation(s).`,
        measurements: { serious: input.accessibility.serious },
      };
}

/**
 * Performance, advisory always.
 *
 * A number from CI is a number from a shared machine under unknown load. Failing a build on it
 * teaches people to re-run until it passes, which destroys the signal and the habit together.
 */
function performanceGate(input: GateInput): GateResult {
  if (!input.performance) return skipped('performance', 'performance data');

  const { budgetMs, measuredMs, label = 'operation' } = input.performance;

  return measuredMs <= budgetMs
    ? {
        gate: 'performance',
        status: 'pass',
        detail: `${label}: ${measuredMs}ms, within the ${budgetMs}ms budget.`,
        measurements: { budgetMs, measuredMs },
      }
    : {
        gate: 'performance',
        status: 'fail',
        detail: `${label}: ${measuredMs}ms exceeds the ${budgetMs}ms budget. Advisory — this does not block.`,
        measurements: { budgetMs, measuredMs },
      };
}

/** Refuses to proceed when a blocking gate failed. */
export function assertGatesPassed(report: QualityReport): void {
  if (report.passed) return;

  throw ApiError.conflict(
    `${report.blocking.length} quality gate(s) failed: ` +
      report.blocking.map((result) => `${result.gate} (${result.detail})`).join('; '),
  );
}
