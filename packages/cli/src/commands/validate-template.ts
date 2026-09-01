import { listTemplates, type TemplateManifest } from '@trustsystem/template-registry';
import { validateTemplate, type ValidationReport } from '@trustsystem/generator-core';
import type { Output } from '../output';
import { style } from '../output';

export interface ValidateTemplateOptions {
  json?: boolean;
  templatesRoot?: string;
  /** Validate every registered template. */
  all?: boolean;
  /**
   * Framework version to check compatibility against.
   *
   * Omitted by default: `validate-template` in a source tree is checking the template, not the
   * checkout, and failing every template because the caller did not pass a flag is how a
   * validator gets ignored.
   */
  frameworkVersion?: string;
}

/**
 * `trustos validate-template [id]`.
 *
 * Exit status is what CI reads: non-zero if any check failed. Warnings are
 * reported but do not fail the command.
 */
export async function runValidateTemplate(
  templateId: string | undefined,
  options: ValidateTemplateOptions,
  output: Output,
): Promise<number> {
  const targets: TemplateManifest[] =
    options.all || !templateId
      ? [...listTemplates()]
      : [...listTemplates()].filter((template) => template.id === templateId);

  if (targets.length === 0) {
    output.error(`Unknown template "${templateId}".`);
    output.detail(
      `  Known: ${listTemplates()
        .map((t) => t.id)
        .join(', ')}`,
    );
    return 1;
  }

  const reports: ValidationReport[] = [];
  for (const template of targets) {
    reports.push(
      await validateTemplate(template.id, {
        ...(options.templatesRoot ? { templatesRoot: options.templatesRoot } : {}),
        ...(options.frameworkVersion ? { frameworkVersion: options.frameworkVersion } : {}),
      }),
    );
  }

  if (options.json) {
    output.info(JSON.stringify(reports, null, 2));
    return reports.every((report) => report.ok) ? 0 : 1;
  }

  for (const report of reports) {
    const failed = report.checks.filter((check) => check.status === 'fail').length;
    const warned = report.checks.filter((check) => check.status === 'warn').length;

    output.info(
      `${report.ok ? style.bold(report.templateId) : style.bold(`${report.templateId} — FAILED`)}`,
    );

    for (const check of report.checks) {
      const mark = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
      const line = `  ${mark} ${check.name.padEnd(28)} ${check.detail}`;
      if (check.status === 'fail') output.error(line.trim());
      else if (check.status === 'warn') output.warn(line.trim());
      else output.detail(line);
    }

    output.detail(`  ${report.checks.length} checks, ${failed} failed, ${warned} warning(s)`);
    output.blank();
  }

  const ok = reports.every((report) => report.ok);
  if (ok) output.success(`${reports.length} template(s) valid.`);
  else output.error('Template validation failed.');

  return ok ? 0 : 1;
}
