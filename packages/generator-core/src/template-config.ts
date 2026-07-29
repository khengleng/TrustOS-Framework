import { z } from 'zod';
import { GeneratorError } from './errors';

/**
 * Per-template generation config, stored as `template.json` beside the
 * template's `files/` tree.
 *
 * The registry manifest describes *what a template is*; this describes *how it
 * is generated*. They are validated against each other by `validate-template`.
 */

const conditionSchema = z
  .object({
    /** POSIX path prefix this rule applies to, relative to the project root. */
    prefix: z.string().min(1),
    /** Variable that must be truthy for the files to be written. */
    when: z.string().min(1).optional(),
    /** Variable that must equal `value` for the files to be written. */
    whenEquals: z
      .object({
        variable: z.string().min(1),
        value: z.union([z.string(), z.boolean(), z.number()]),
      })
      .strict()
      .optional(),
    /** Why this rule exists. Required — a silent skip is hard to debug. */
    reason: z.string().min(1),
  })
  .strict()
  .refine((rule) => Boolean(rule.when) !== Boolean(rule.whenEquals), {
    message: 'Specify exactly one of "when" or "whenEquals".',
  });

export const templateConfigSchema = z
  .object({
    id: z.string().min(1),
    /** Paths omitted unless a condition holds. Evaluated in order. */
    conditionalPaths: z.array(conditionSchema).default([]),
  })
  .strict();

export type TemplateConfig = z.infer<typeof templateConfigSchema>;
export type PathCondition = TemplateConfig['conditionalPaths'][number];

export function parseTemplateConfig(raw: unknown, sourceName: string): TemplateConfig {
  const result = templateConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new GeneratorError('template_invalid', `${sourceName} is invalid: ${problems}`);
  }
  return result.data;
}

/**
 * Decides whether a generated path is included.
 *
 * Default is *include*: a template file with no matching rule is always
 * written. Rules therefore only ever remove files, never silently add them.
 */
export function shouldInclude(
  targetPath: string,
  conditions: PathCondition[],
  values: Record<string, unknown>,
): boolean {
  for (const condition of conditions) {
    if (!matchesPrefix(targetPath, condition.prefix)) continue;

    if (condition.when) {
      if (!values[condition.when]) return false;
      continue;
    }

    if (condition.whenEquals) {
      if (values[condition.whenEquals.variable] !== condition.whenEquals.value) return false;
    }
  }
  return true;
}

/** Prefix match on path segments, so `apps/admin` never matches `apps/adminx`. */
function matchesPrefix(targetPath: string, prefix: string): boolean {
  if (targetPath === prefix) return true;
  return targetPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}
