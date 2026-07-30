import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  checkCompatibility,
  compareSemver,
  findTemplate,
  resolveTemplateChain,
} from '@trustos/template-registry';
import type { Output } from '../output';
import { formatRows, style } from '../output';

/**
 * `trustos update-template` and `trustos doctor template`.
 *
 * Both read a *generated project* rather than the framework, and both are deliberately read-only.
 *
 * The thing to be honest about up front: **there is no automatic upgrade.** Generation is a
 * one-time act, and by the time a project is worth upgrading somebody has edited most of what the
 * template wrote. A command that re-rendered the template over their work would either clobber it
 * or produce a merge nobody asked for. So `update-template` *reports* — what version generated
 * this, what the template says now, what changed between them — and a human decides what to do
 * with the answer.
 *
 * That is less than the name promises, and saying so is better than a tool that silently
 * overwrites a service somebody spent a month on.
 */

export interface TemplateDoctorOptions {
  path?: string;
  json?: boolean;
}

interface ProjectManifest {
  frameworkVersion?: string;
  template?: string;
  templateVersion?: string;
  cliVersion?: string;
  generatedAt?: string;
  application?: { name?: string; packageName?: string };
  generated?: Record<string, unknown>;
}

export interface TemplateFinding {
  area: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  detail: string;
  remediation?: string;
}

/** Walks up looking for `trustos.json`, so the command works from anywhere inside a project. */
function findApplicationRoot(start: string): string | null {
  let current = start;

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'trustos.json'))) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function loadManifest(
  options: TemplateDoctorOptions,
  output: Output,
): Promise<{ root: string; manifest: ProjectManifest } | null> {
  const root = options.path ?? findApplicationRoot(process.cwd());

  if (!root) {
    output.error('No trustos.json found in this directory or any parent.');
    output.detail('Run this inside a generated application, or pass --path.');
    return null;
  }

  try {
    const manifest = JSON.parse(
      await readFile(join(root, 'trustos.json'), 'utf8'),
    ) as ProjectManifest;
    return { root, manifest };
  } catch (error) {
    output.error(
      `trustos.json in ${root} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------

/** `trustos update-template` — what has changed since this project was generated. */
export async function runUpdateTemplate(
  options: TemplateDoctorOptions,
  output: Output,
): Promise<number> {
  const loaded = await loadManifest(options, output);
  if (!loaded) return 1;

  const { manifest } = loaded;
  const templateId = manifest.template;

  if (!templateId) {
    output.error('trustos.json does not record which template generated this project.');
    output.detail('It was generated before templates were recorded, or the file was edited.');
    return 1;
  }

  const template = findTemplate(templateId);

  if (!template) {
    /*
     * A removed template is not an error the developer caused, and their project still works —
     * nothing generated has a runtime dependency on the template it came from. Say so plainly.
     */
    output.error(`Template "${templateId}" is no longer in the registry.`);
    output.detail(
      'Your project is unaffected — a generated project has no runtime dependency on its ' +
        'template. There is simply nothing left to compare against.',
    );
    return 1;
  }

  const generatedWith = manifest.templateVersion ?? '0.0.0';
  const current = template.version;
  const drift = compareSemver(current, generatedWith);

  if (options.json) {
    output.info(
      JSON.stringify(
        {
          template: templateId,
          generatedWith,
          current,
          behind: drift > 0,
          status: template.status,
          supersededBy: template.supersededBy ?? null,
          chain: resolveTemplateChain(templateId).map((entry) => entry.id),
          migrationNotes: template.migrationNotes,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  output.info(style.bold(`${template.displayName} (${templateId})`));
  output.blank();
  output.info(
    `  generated with   v${generatedWith}${manifest.generatedAt ? ` on ${manifest.generatedAt.slice(0, 10)}` : ''}`,
  );
  output.info(`  registry has     v${current}`);
  output.blank();

  if (drift <= 0) {
    output.success('Up to date.');
  } else {
    output.warn('The template has moved on since this project was generated.');
    output.blank();
    output.info('  What changed, per the template owner:');
    output.detail(`    ${template.migrationNotes}`);
  }

  if (template.status === 'deprecated' && template.supersededBy) {
    output.blank();
    output.warn(`"${templateId}" is deprecated. Its successor is "${template.supersededBy}".`);
  }

  output.blank();
  output.detail('  There is no automatic upgrade, and that is deliberate:');
  output.detail('  by now you have edited most of what the template wrote, and re-rendering over');
  output.detail('  your work would clobber it. Read the notes above and apply what applies.');
  output.detail('');
  output.detail(`  Diff against a fresh generation:`);
  output.detail(`    trustos new ${templateId} --name reference --dry-run`);

  return 0;
}

// ---------------------------------------------------------------------------

/** `trustos doctor template` — is this project still consistent with its template? */
export async function runTemplateDoctor(
  options: TemplateDoctorOptions,
  output: Output,
): Promise<number> {
  const loaded = await loadManifest(options, output);
  if (!loaded) return 1;

  const { root, manifest } = loaded;
  const findings: TemplateFinding[] = [];

  const templateId = manifest.template;
  const template = templateId ? findTemplate(templateId) : undefined;

  if (!templateId) {
    findings.push({
      area: 'provenance',
      status: 'FAIL',
      detail: 'trustos.json does not record which template generated this project.',
      remediation: 'Add "template" and "templateVersion" so upgrades can be reasoned about.',
    });
  } else if (!template) {
    findings.push({
      area: 'provenance',
      status: 'WARN',
      detail: `Generated from "${templateId}", which is no longer in the registry.`,
      remediation:
        'Nothing is broken — a generated project has no runtime dependency on its template — ' +
        'but there is nothing to compare against either.',
    });
  } else {
    findings.push({
      area: 'provenance',
      status: 'PASS',
      detail: `Generated from ${template.displayName} v${manifest.templateVersion ?? '?'}.`,
    });

    findings.push(...checkVersionDrift(template, manifest));
    findings.push(...checkStatus(template));
    await pushAsync(findings, checkStructure(root, template));
    await pushAsync(findings, checkFrameworkPin(root, manifest, template));
  }

  if (options.json) {
    output.info(JSON.stringify({ template: templateId ?? null, findings }, null, 2));
    return findings.some((finding) => finding.status === 'FAIL') ? 1 : 0;
  }

  output.info(style.bold('Template health'));
  output.detail(`  ${root}`);
  output.blank();

  // Two columns, so the marks line up with the area names rather than drifting with the longest
  // detail. Same shape as `doctor integrations`, because they are read side by side.
  output.info(
    formatRows(
      findings.map((finding) => [`${finding.status.padEnd(4)}  ${finding.area}`, finding.detail]),
    ),
  );

  const actionable = findings.filter((finding) => finding.remediation);

  if (actionable.length > 0) {
    output.blank();
    output.info(style.bold('What to do'));
    for (const finding of actionable) {
      output.detail(`  ${finding.area}`);
      output.detail(`    ${finding.remediation}`);
    }
  }

  output.blank();

  const failures = findings.filter((finding) => finding.status === 'FAIL').length;

  if (failures > 0) {
    output.error(`${failures} problem(s) that will stop this application working.`);
    return 1;
  }

  output.success('This application still matches the template it came from.');
  return 0;
}

async function pushAsync(
  findings: TemplateFinding[],
  promise: Promise<TemplateFinding[]>,
): Promise<void> {
  findings.push(...(await promise));
}

function checkVersionDrift(
  template: NonNullable<ReturnType<typeof findTemplate>>,
  manifest: ProjectManifest,
): TemplateFinding[] {
  const generatedWith = manifest.templateVersion ?? '0.0.0';
  const drift = compareSemver(template.version, generatedWith);

  if (drift > 0) {
    return [
      {
        area: 'template version',
        status: 'WARN',
        detail: `Generated with v${generatedWith}; the registry now has v${template.version}.`,
        remediation: 'Run `trustos update-template` to see what changed.',
      },
    ];
  }

  if (drift < 0) {
    /*
     * The project was generated by a *newer* framework than this checkout. Worth flagging: the
     * developer is probably running an old CLI, and every other answer this command gives them
     * is being computed against the wrong registry.
     */
    return [
      {
        area: 'template version',
        status: 'WARN',
        detail:
          `Generated with v${generatedWith}, which is newer than the v${template.version} this ` +
          'checkout knows about.',
        remediation: 'Update the framework checkout; this CLI is older than the project.',
      },
    ];
  }

  return [
    {
      area: 'template version',
      status: 'PASS',
      detail: `Matches the registry (v${template.version}).`,
    },
  ];
}

function checkStatus(template: NonNullable<ReturnType<typeof findTemplate>>): TemplateFinding[] {
  const report = checkCompatibility(template, template.minimumFrameworkVersion);

  if (report.warnings.length === 0) {
    return [{ area: 'template status', status: 'PASS', detail: 'Stable.' }];
  }

  return report.warnings.map((warning) => ({
    area: 'template status',
    status: 'WARN' as const,
    detail: warning,
    remediation:
      template.status === 'deprecated'
        ? `New projects should use "${template.supersededBy}". This one keeps working.`
        : 'Pin the template version you generated with before relying on entity names.',
  }));
}

/**
 * Whether the project still has the structure the template generated.
 *
 * Not a diff — files are meant to be edited. What this catches is a *missing* piece: a product
 * module that was deleted, a schema fragment that was never copied, an isolation test somebody
 * removed to make CI green.
 */
async function checkStructure(
  root: string,
  template: NonNullable<ReturnType<typeof findTemplate>>,
): Promise<TemplateFinding[]> {
  const findings: TemplateFinding[] = [];

  if (template.includedApps.includes('api')) {
    const productModule = join(root, 'apps/api/src/modules/product/product.module.ts');

    findings.push(
      existsSync(productModule)
        ? {
            area: 'product module',
            status: 'PASS',
            detail: 'apps/api/src/modules/product is present.',
          }
        : {
            area: 'product module',
            status: 'FAIL',
            detail: 'apps/api/src/modules/product/product.module.ts is missing.',
            remediation:
              'The composition root imports it by a fixed name, so the API will not start ' +
              'without it.',
          },
    );

    const chain = resolveTemplateChain(template.id);
    const missingLayers = chain
      .map((entry) => entry.id)
      .filter((id) => !existsSync(join(root, 'apps/api/src/modules/product', id)));

    if (chain.length > 1) {
      findings.push(
        missingLayers.length === 0
          ? {
              area: 'template layers',
              status: 'PASS',
              detail: `All ${chain.length} layer(s) present: ${chain.map((e) => e.id).join(' → ')}.`,
            }
          : {
              area: 'template layers',
              status: 'WARN',
              detail: `Layer folder(s) missing: ${missingLayers.join(', ')}.`,
              remediation:
                'A layer removed on purpose is fine; one removed by accident takes its models ' +
                'and permissions with it.',
            },
      );
    }
  }

  const schemaDirectory = join(root, 'prisma/schema');

  findings.push(
    existsSync(join(schemaDirectory, '00-framework.prisma'))
      ? {
          area: 'framework schema',
          status: 'PASS',
          detail: 'prisma/schema/00-framework.prisma is present.',
        }
      : {
          area: 'framework schema',
          status: 'FAIL',
          detail: 'prisma/schema/00-framework.prisma is missing.',
          remediation:
            'Every generated project owns a copy of the framework models; Prisma has no ' +
            'cross-package schema import.',
        },
  );

  return findings;
}

/**
 * Whether the project's framework dependency matches what it was generated against.
 *
 * A project generated against 0.1.0 and now depending on 0.4.0 is not broken — but it has picked
 * up four phases of framework changes without anybody reading the notes, and this is the only
 * place that fact is visible.
 */
async function checkFrameworkPin(
  root: string,
  manifest: ProjectManifest,
  template: NonNullable<ReturnType<typeof findTemplate>>,
): Promise<TemplateFinding[]> {
  const packageJsonPath = join(root, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return [
      {
        area: 'framework version',
        status: 'WARN',
        detail: 'No package.json to read a version from.',
      },
    ];
  }

  const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  const specifier = parsed.dependencies?.['@trustos/config'];

  if (!specifier) {
    return [
      {
        area: 'framework version',
        status: 'WARN',
        detail: 'No @trustos/config dependency found, so the framework version cannot be read.',
      },
    ];
  }

  if (specifier.startsWith('file:')) {
    return [
      {
        area: 'framework version',
        status: 'INFO',
        detail: 'Framework packages are linked from a local checkout (file:), not a registry.',
      },
    ];
  }

  const generatedAgainst = manifest.frameworkVersion ?? '0.0.0';
  const installed = specifier.replace(/^[\^~]/, '');

  if (compareSemver(installed, template.minimumFrameworkVersion) < 0) {
    return [
      {
        area: 'framework version',
        status: 'FAIL',
        detail: `Depends on framework ${installed}; "${template.id}" needs ${template.minimumFrameworkVersion} or newer.`,
        remediation: 'Upgrade the @trustos/* dependencies.',
      },
    ];
  }

  return compareSemver(installed, generatedAgainst) > 0
    ? [
        {
          area: 'framework version',
          status: 'INFO',
          detail: `Generated against ${generatedAgainst}; now on ${installed}.`,
          remediation: 'Check the framework changelog for anything the generated code relies on.',
        },
      ]
    : [
        {
          area: 'framework version',
          status: 'PASS',
          detail: `On framework ${installed}, as generated.`,
        },
      ];
}
