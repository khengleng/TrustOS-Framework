import { FRAMEWORK_LAYERS, FRAMEWORK_RULES, type ArchitectureRule, type Layer } from './rules';

/**
 * The architecture check.
 *
 * Takes files as data — path and content — and never touches the filesystem. That is what makes it
 * testable without a fixture tree, usable on a diff rather than a whole repository, and callable
 * from a pre-commit hook, CI and `trustos architecture-check` with identical behaviour.
 *
 * Every check here is a *pattern* check, and patterns have false positives. The response to that
 * is not to weaken the patterns but to make each violation say exactly which line and what to do,
 * so dismissing a false positive costs seconds. A check that is hard to dismiss gets disabled
 * wholesale, and then the true positives go with it.
 */

export interface SourceFile {
  /** Repository-relative path. */
  path: string;
  content: string;
}

export interface Violation {
  ruleId: string;
  kind: ArchitectureRule['kind'];
  severity: 'error' | 'warning';
  file: string;
  line: number;
  detail: string;
  remediation: string;
}

export interface ArchitectureReport {
  violations: Violation[];
  filesChecked: number;
  ok: boolean;
}

export interface ValidateOptions {
  files: readonly SourceFile[];
  rules?: readonly ArchitectureRule[];
  layers?: readonly Layer[];
  /** Declared dependencies per package, for `declared-dependencies-only`. */
  declaredDependencies?: Readonly<Record<string, readonly string[]>>;
}

export function validateArchitecture(options: ValidateOptions): ArchitectureReport {
  const rules = options.rules ?? FRAMEWORK_RULES;
  const layers = options.layers ?? FRAMEWORK_LAYERS;
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const violations: Violation[] = [];

  for (const file of options.files) {
    if (!isSource(file.path)) continue;

    const lines = file.content.split('\n');

    const generated = templateLiteralLines(lines);

    violations.push(...checkLayering(file, lines, generated, layers, byId));
    violations.push(...checkImports(file, lines, generated, byId, options.declaredDependencies));
    violations.push(...checkNaming(file, byId));
    violations.push(...checkStructure(file, byId));
    violations.push(...checkSecurity(file, lines, byId));
  }

  return {
    violations,
    filesChecked: options.files.filter((file) => isSource(file.path)).length,
    ok: !violations.some((violation) => violation.severity === 'error'),
  };
}

const isSource = (path: string): boolean =>
  /\.(ts|tsx)$/.test(path) && !path.includes('/dist/') && !path.includes('/node_modules/');

const isTest = (path: string): boolean => /\.spec\.ts$/.test(path);

/**
 * Whether a line's `from '@trustos/x'` sits inside a string literal.
 *
 * `@trustos/code-generator` emits import statements *as strings*. Counting those as imports makes
 * a generator appear to depend on everything it can generate code for, which is both wrong and
 * unfixable — the whole point is that it does not import them.
 */
const isQuotedSource = (line: string): boolean =>
  /['"`][^'"`]*\bfrom\s+\\?['"]@trustos\//.test(line) || /lines\.push\(/.test(line);

/**
 * Which lines sit inside a multi-line template literal.
 *
 * Necessary because a code generator writes whole files as backtick templates, and every import
 * statement inside one looks exactly like an import. Without this, `@trustos/generator-core`
 * appears to depend on every package it can generate a file for — which is both wrong and
 * unfixable, since not importing them is the point.
 *
 * Backtick counting, not parsing. It is defeated by a backtick inside a comment, and the cost of
 * that is one false negative on one line; a real parser here would be a TypeScript dependency in
 * a package whose whole value is that it has none.
 */
function templateLiteralLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let open = false;

  lines.forEach((line, index) => {
    if (open) inside.add(index);

    const backticks = (line.match(/(?<!\\)`/g) ?? []).length;

    if (backticks % 2 === 1) {
      open = !open;
      if (open) inside.add(index);
    }
  });

  return inside;
}

/**
 * Scripts whose output *is* their interface.
 *
 * The CLI prints tables and a seed script prints progress. Routing either through a structured
 * logger would emit JSON where a human expects text, and a rule that fights the thing it is
 * protecting is a rule that gets switched off wholesale.
 */
const printsForHumans = (path: string): boolean =>
  path.startsWith('packages/cli/') || /\/(seed|scaffold|bench|sync)[.-]/.test(path);

/**
 * An inline suppression: `// architecture-ignore: <rule-id> — <reason>` on the line above.
 *
 * A reason is required, and the rule id must be named. A blanket `// eslint-disable-next-line`
 * with no reason is how a rule stops meaning anything — the suppression outlives the person who
 * understood it, and the next reader cannot tell whether it is still true.
 *
 * There is no file-level or repository-level suppression, deliberately. A rule that can be
 * switched off for a whole file is a rule that gets switched off for a whole file.
 */
function suppressedAt(lines: readonly string[], index: number, ruleId: string): boolean {
  const previous = lines[index - 1] ?? '';
  const match = /architecture-ignore:\s*([a-z0-9-]+)\s*[—-]\s*(.+)$/.exec(previous);

  return match?.[1] === ruleId && (match[2] ?? '').trim().length >= 10;
}

function violate(
  rule: ArchitectureRule | undefined,
  file: string,
  line: number,
  detail: string,
): Violation[] {
  if (!rule) return [];

  return [
    {
      ruleId: rule.id,
      kind: rule.kind,
      severity: rule.severity,
      file,
      line,
      detail,
      remediation: rule.remediation,
    },
  ];
}

/** Which layer a path belongs to. The most specific prefix wins. */
export function layerOf(path: string, layers: readonly Layer[]): Layer | null {
  let best: Layer | null = null;
  let bestLength = -1;

  for (const layer of layers) {
    for (const prefix of layer.paths) {
      if (path.startsWith(prefix) && prefix.length > bestLength) {
        best = layer;
        bestLength = prefix.length;
      }
    }
  }

  return best;
}

function checkLayering(
  file: SourceFile,
  lines: readonly string[],
  generated: ReadonlySet<number>,
  layers: readonly Layer[],
  byId: Map<string, ArchitectureRule>,
): Violation[] {
  const own = layerOf(file.path, layers);
  if (!own) return [];

  const violations: Violation[] = [];

  lines.forEach((line, index) => {
    if (generated.has(index) || isQuotedSource(line)) return;

    const match = /from\s+'@trustos\/([a-z0-9-]+)'/.exec(line);
    if (!match) return;

    const target = `packages/${match[1]}`;
    const targetLayer = layerOf(target, layers);

    if (!targetLayer || targetLayer.name === own.name) return;
    if (own.mayDependOn.includes(targetLayer.name)) return;

    violations.push(
      ...violate(
        byId.get('no-upward-dependency'),
        file.path,
        index + 1,
        `${own.name} imports @trustos/${match[1]} (${targetLayer.name}), which it may not reach. ` +
          `${own.name} may depend on: ${own.mayDependOn.join(', ') || 'nothing'}.`,
      ),
    );
  });

  return violations;
}

function checkImports(
  file: SourceFile,
  lines: readonly string[],
  generated: ReadonlySet<number>,
  byId: Map<string, ArchitectureRule>,
  declared: Readonly<Record<string, readonly string[]>> | undefined,
): Violation[] {
  const violations: Violation[] = [];
  const owner = /^packages\/([a-z0-9-]+)\//.exec(file.path)?.[1];

  lines.forEach((line, index) => {
    if (generated.has(index) || isQuotedSource(line)) return;

    const deep = /from\s+'@trustos\/[a-z0-9-]+\/(src|dist)\//.exec(line);

    if (deep) {
      violations.push(
        ...violate(
          byId.get('no-cross-package-deep-import'),
          file.path,
          index + 1,
          `Deep import: ${line.trim()}`,
        ),
      );
    }

    if (!owner || !declared) return;

    const match = /from\s+'@trustos\/([a-z0-9-]+)'/.exec(line);
    if (!match || match[1] === owner) return;

    const allowed = declared[owner];
    // No entry means the package's manifest was not supplied; silence beats guessing.
    if (!allowed || allowed.includes(match[1] as string)) return;

    /*
     * A test may import anything: a spec that needs a fixture from another package is not a
     * production dependency, and forcing it into package.json would put test-only packages into
     * every consumer's install.
     */
    if (isTest(file.path)) return;

    violations.push(
      ...violate(
        byId.get('declared-dependencies-only'),
        file.path,
        index + 1,
        `${owner} imports @trustos/${match[1]}, which is not in its dependencies.`,
      ),
    );
  });

  return violations;
}

function checkNaming(file: SourceFile, byId: Map<string, ArchitectureRule>): Violation[] {
  const name = file.path.split('/').pop() ?? '';
  const base = name.replace(/\.(spec\.)?tsx?$/, '');

  /*
   * Dot-separated kebab segments: `audit.service`, `scope.guard`, `tenant.interceptor`.
   *
   * The Nest convention, used consistently across the repository. A naming rule that fights the
   * framework it wires would be a rule with eighty violations on day one, and eighty violations
   * is not a standard — it is a standard nobody adopted.
   */
  if (/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/.test(base)) return [];

  // Next.js requires these exact names, and a framework rule that fights the framework it
  // generates for is a rule that gets switched off.
  if (['index', 'page', 'layout', 'route', 'middleware', 'not-found'].includes(base)) return [];
  if (/^\[.+\]$/.test(base)) return [];

  return violate(byId.get('kebab-case-files'), file.path, 1, `"${name}" is not kebab-case.`);
}

function checkStructure(file: SourceFile, byId: Map<string, ArchitectureRule>): Violation[] {
  if (!isTest(file.path)) return [];

  if (file.path.includes('/__tests__/') || file.path.includes('/test/')) {
    return violate(
      byId.get('spec-beside-source'),
      file.path,
      1,
      'Test lives in a separate tree rather than beside its subject.',
    );
  }

  return [];
}

/**
 * The security patterns.
 *
 * Each one is narrow enough to have few false positives and broad enough to catch the real thing.
 * The comment-stripping matters: a doc comment saying "never use console.log here" would
 * otherwise be a violation of the rule it is explaining.
 */
function checkSecurity(
  file: SourceFile,
  lines: readonly string[],
  byId: Map<string, ArchitectureRule>,
): Violation[] {
  const violations: Violation[] = [];

  const secretPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key' },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/, label: 'GitHub token' },
    { pattern: /\bsk-[A-Za-z0-9]{20,}/, label: 'API secret key' },
    {
      pattern: /(secret|password|token|apiKey)\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
      label: 'credential literal',
    },
  ];

  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    const isComment =
      trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');

    if (isComment) return;

    /*
     * Test files are exempt from the *pattern* checks — secrets, raw SQL, float arithmetic.
     *
     * A spec that verifies a token is rejected has to contain a token-shaped string; one that
     * proves a query is parameterized has to contain an unparameterized one. The rule fires on
     * every such test, and a rule whose findings are almost all false is a rule people switch off
     * wholesale, taking the true findings with it.
     *
     * The layering and dependency rules still apply to tests, because those have no equivalent
     * "the fixture is the point" defence.
     */
    if (isTest(file.path)) return;

    for (const { pattern, label } of secretPatterns) {
      if (pattern.test(line) && !suppressedAt(lines, index, 'no-secret-in-source')) {
        violations.push(
          ...violate(byId.get('no-secret-in-source'), file.path, index + 1, `Possible ${label}.`),
        );
      }
    }

    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line)) {
      /*
       * The CLI is the exception: printing to stdout *is* its output, and routing it through a
       * structured logger would emit JSON where a human expects a table.
       */
      if (!printsForHumans(file.path)) {
        violations.push(
          ...violate(
            byId.get('no-console-in-packages'),
            file.path,
            index + 1,
            'console call in a framework package.',
          ),
        );
      }
    }

    if (/\$queryRaw(?:Unsafe)?\s*\(\s*`/.test(line) || /\$queryRawUnsafe\s*\(/.test(line)) {
      violations.push(
        ...violate(
          byId.get('no-raw-sql-interpolation'),
          file.path,
          index + 1,
          'Raw SQL built from a string.',
        ),
      );
    }

    if (/\b(amount|price|balance|total)\b\s*[*/+-]\s*\d*\.\d/.test(line)) {
      violations.push(
        ...violate(
          byId.get('no-float-money'),
          file.path,
          index + 1,
          'Floating-point arithmetic on what looks like a monetary value.',
        ),
      );
    }
  });

  return violations;
}

/** Violations grouped by rule, worst first. What a report prints. */
export function groupByRule(report: ArchitectureReport): Array<{
  ruleId: string;
  severity: 'error' | 'warning';
  count: number;
  violations: Violation[];
}> {
  const groups = new Map<string, Violation[]>();

  for (const violation of report.violations) {
    groups.set(violation.ruleId, [...(groups.get(violation.ruleId) ?? []), violation]);
  }

  return [...groups.entries()]
    .map(([ruleId, violations]) => ({
      ruleId,
      severity: violations[0]!.severity,
      count: violations.length,
      violations,
    }))
    .sort((a, b) =>
      a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1,
    );
}
