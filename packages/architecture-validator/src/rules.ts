import { z } from 'zod';

/**
 * Architecture rules, as data.
 *
 * The rules a codebase actually lives by are the ones a machine checks. Everything else is a
 * document people agree with and then violate, because the violation is invisible until somebody
 * reads the whole tree — and nobody reads the whole tree.
 *
 * So the rules are declarations, checked by `validateArchitecture`, and the failures name the file
 * and say what to do. A violation report that says "layering violation in src/" is a report that
 * gets closed.
 *
 * Five kinds, matching the five ways a codebase decays:
 *
 *   * **Layering** — something low-level reaches up, and the low-level thing stops being reusable.
 *   * **Naming** — two conventions coexist, and neither is greppable.
 *   * **Dependency** — a package imports something it never declared, and the build works until
 *     somebody installs it alone.
 *   * **Structure** — a file lands where nobody looks for it.
 *   * **Security** — a guard is bypassed, a secret is logged, a tenant scope is dropped.
 *
 * The security rules are the ones that must never be waived, and `severity` cannot be lowered
 * below `error` for them — see `architectureRuleSchema`.
 */

export const RULE_KINDS = ['layering', 'naming', 'dependency', 'structure', 'security'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const architectureRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Lowercase kebab-case.'),
    kind: z.enum(RULE_KINDS),
    description: z.string().min(1).max(300),
    /** Files this applies to, as a glob-ish prefix or a regular expression source. */
    appliesTo: z.string().min(1).max(200),
    severity: z.enum(['error', 'warning']).default('error'),
    /**
     * What to do about a violation. Required, and the reason the reports are actionable: a rule
     * that only says what is wrong makes every reader work out the fix independently.
     */
    remediation: z.string().min(1).max(300),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.kind === 'security' && rule.severity !== 'error') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['severity'],
        message:
          'A security rule cannot be a warning. A warning is a rule the build does not enforce, ' +
          'and an unenforced security rule is a comment.',
      });
    }
  });

export type ArchitectureRule = z.infer<typeof architectureRuleSchema>;

/** A layer, and what it may depend on. Directional: the list is what it may reach *downward*. */
export const layerSchema = z
  .object({
    name: z.string().min(1).max(40),
    /** Path prefixes belonging to this layer. */
    paths: z.array(z.string().min(1).max(200)).min(1),
    /** Layers it may depend on. A layer always may depend on itself. */
    mayDependOn: z.array(z.string().min(1).max(40)).default([]),
  })
  .strict();

export type Layer = z.infer<typeof layerSchema>;

/**
 * The framework's own layering.
 *
 * Four layers, and the direction is always downward. The rule that does the work is the last one:
 * `product` may reach everything, and nothing may reach `product`. The moment a foundation
 * package imports a product one, the foundation cannot be reused without the product — which is
 * the moment a framework stops being one.
 */
export const FRAMEWORK_LAYERS: Layer[] = [
  {
    name: 'foundation',
    paths: [
      'packages/errors',
      'packages/validation',
      'packages/shared-types',
      'packages/config',
      'packages/logging',
    ],
    mayDependOn: [],
  },
  {
    name: 'platform',
    paths: [
      'packages/database',
      'packages/auth',
      'packages/rbac',
      'packages/tenancy',
      'packages/audit',
      'packages/observability',

      /*
       * The authorization engine and the two packages it reports decisions through. They sit in
       * `platform` rather than `capability` because every capability above them may need to ask
       * "is this allowed" — putting them higher would make the question unaskable from anything
       * that is not itself a capability.
       */
      'packages/authorization',
      'packages/security-policy',
      'packages/security-events',

      /*
       * The security test harness. It sits with the packages it exercises rather than above them
       * so their own specs can use it — a test utility a package cannot reach from its own tests
       * is a test utility nobody uses.
       */
      'packages/security-testing',
    ],
    mayDependOn: ['foundation'],
  },
  {
    name: 'capability',
    paths: ['packages/'],
    mayDependOn: ['foundation', 'platform'],
  },
  {
    name: 'product',
    paths: ['apps/', 'templates/'],
    mayDependOn: ['foundation', 'platform', 'capability'],
  },
];

/**
 * The rules the framework holds itself to.
 *
 * Every one of these was written after the failure it describes, which is why they are specific
 * rather than aspirational.
 */
export const FRAMEWORK_RULES: ArchitectureRule[] = [
  {
    id: 'no-upward-dependency',
    kind: 'layering',
    description: 'A package may not import from a layer above it.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation:
      'Invert the dependency with an extension point, or move the shared piece down a layer. A ' +
      'foundation package that imports a product one cannot be reused without the product.',
  },
  {
    id: 'no-cross-package-deep-import',
    kind: 'dependency',
    description: 'Import a package by its name, never by a path into its src/ or dist/.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation:
      'Import from `@trustos/<package>`. A deep import binds to a file layout that is not part of ' +
      'the contract, and it breaks on a refactor nobody thought was breaking.',
  },
  {
    id: 'declared-dependencies-only',
    kind: 'dependency',
    description: 'A package may only import framework packages it declares in package.json.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation:
      'Add it to dependencies and to the tsconfig references. An undeclared import works in the ' +
      'monorepo and fails when the package is installed on its own.',
  },
  {
    id: 'kebab-case-files',
    kind: 'naming',
    description: 'Source files are kebab-case.',
    appliesTo: 'packages/',
    severity: 'warning',
    remediation: 'Rename the file. Two conventions in one tree means neither is greppable.',
  },
  {
    id: 'spec-beside-source',
    kind: 'structure',
    description: 'A test lives beside the file it tests, as <name>.spec.ts.',
    appliesTo: 'packages/',
    severity: 'warning',
    remediation:
      'Move the test next to its subject. A separate test tree is a tree that drifts out of step ' +
      'with the one it tests.',
  },
  {
    id: 'no-secret-in-source',
    kind: 'security',
    description: 'No key, token or credential-shaped literal in source.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation: 'Read it from configuration. A committed secret is a rotated secret.',
  },
  {
    id: 'no-console-in-packages',
    kind: 'security',
    description: 'Framework packages log through @trustos/logging, never console.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation:
      'Use the logger. `console.log` bypasses redaction, so a value that would have been masked ' +
      'reaches the log in full.',
  },
  {
    id: 'no-raw-sql-interpolation',
    kind: 'security',
    description: 'No template literal inside $queryRaw.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation:
      'Use $queryRaw`` tagged-template parameterization or Prisma.sql. String-built SQL is an ' +
      'injection whatever the input looks like today.',
  },
  {
    id: 'no-float-money',
    kind: 'security',
    description: 'No floating-point arithmetic on a monetary value.',
    appliesTo: 'packages/',
    severity: 'error',
    remediation:
      'Use @trustos/financial-core. A float agrees with every test and disagrees with the ' +
      'counterparty once in ten thousand transactions.',
  },
];
