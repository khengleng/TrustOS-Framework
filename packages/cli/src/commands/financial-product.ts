import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  APPROVED_BLOCKS,
  blockCatalogSummary,
  type BlockCategory,
} from '@trustos/financial-block-registry';
import { PROVIDER_INTERFACES, PROVIDER_INTERFACE_NAMES, connectorDefinitionSchema } from '@trustos/connector-registry';
import {
  PRODUCT_TEMPLATES,
  findTemplate,
  validateProduct,
  type ValidationFinding,
} from '@trustos/financial-product-composer';
import {
  classifyChange,
  assessGovernance,
} from '@trustos/financial-product-governance';
import {
  parseProductDefinition,
  structuralReferenceData,
  type ProductDefinition,
} from '@trustos/financial-product-core';
import { publishVersion } from '@trustos/financial-product-versioning';
import { formatReport, simulate } from '@trustos/financial-product-simulator';
import { style, type Output } from '../output';

/** Pretty JSON, for `--json`. One helper so every command's machine output looks the same. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * A column-aligned table.
 *
 * `formatRows` in `../output` handles two columns; these commands need four — a block id, a
 * version, a monetary effect and a description read badly when they are not aligned, and a
 * catalog of eighty-four blocks is exactly where alignment stops being cosmetic.
 */
function table(rows: string[][], indent = '  '): string {
  const widths: number[] = [];

  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }

  return rows
    .map((row) =>
      `${indent}${row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join('  ')}`.trimEnd(),
    )
    .join('\n');
}

/**
 * `trustos financial-product`, `trustos financial-block`, `trustos connector`.
 *
 * All of it **read-only and offline**, like the workflow and financial doctors: it parses a file,
 * walks a graph and prints. No database, no network, no product published and no transaction
 * created.
 *
 * That constraint shapes two commands in a way worth being explicit about, because their names
 * promise more than they do:
 *
 *   * **`publish`** does not publish. It produces the *plan* — what validation says, which
 *     approval levels the change needs, and what governance would refuse — because publishing
 *     needs a registry, an actor and an approval trail, none of which exist on a laptop. The
 *     command is what somebody runs before opening the request, and it answers "will this be
 *     refused" without asking anybody.
 *   * **`rollback`** is the same shape, for the same reason.
 *
 * Naming them `publish-plan` would be more honest and less useful: the specification asks for
 * `publish`, people will type `publish`, and a command that does not exist teaches nothing. The
 * output says plainly, every time, that nothing was written.
 */

export interface ProductCommandOptions {
  json?: boolean;
  path?: string;
  verbose?: boolean;
}

/**
 * Reads a definition from a file.
 *
 * JSON only, for the reason the workflow command gives: a YAML parser in the CLI is a parser
 * reachable from a file path, and the two most common ones have both had deserialization
 * vulnerabilities.
 */
async function readDocument(path: string): Promise<{ document: unknown } | { error: string }> {
  const absolute = resolve(path);

  if (extname(absolute) === '.yaml' || extname(absolute) === '.yml') {
    return {
      error:
        `${path} looks like YAML. The CLI reads JSON only — convert it first. See ` +
        'docs/product-composition.md.',
    };
  }

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (error) {
    return { error: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    return { document: JSON.parse(raw) as unknown };
  } catch (error) {
    return {
      error: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readDefinition(
  path: string,
  output: Output,
): Promise<ProductDefinition | null> {
  const result = await readDocument(path);

  if ('error' in result) {
    output.error(result.error);
    return null;
  }

  try {
    return parseProductDefinition(result.document);
  } catch (error) {
    output.error(`${path} is not a valid product definition.`);
    output.blank();
    output.detail(`  ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return null;
  }
}

function printFindings(findings: readonly ValidationFinding[], output: Output): void {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  for (const finding of errors) {
    output.error(`  ${style.bold(finding.subject)}  ${finding.message}`);
    output.detail(`    fix: ${finding.remediation}`);
  }

  for (const finding of warnings) {
    output.warn(`  ${style.bold(finding.subject)}  ${finding.message}`);
    output.detail(`    fix: ${finding.remediation}`);
  }
}

// --- financial-product list -------------------------------------------------

export function runProductList(options: ProductCommandOptions, output: Output): number {
  if (options.json) {
    output.info(json(
      PRODUCT_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
      })),
    ));
    return 0;
  }

  output.info(style.bold('Product templates'));
  output.blank();
  output.info(
    table(PRODUCT_TEMPLATES.map((template) => [template.id, template.name, template.description])),
  );
  output.blank();
  output.detail('  Start one with: trustos financial-product create <id> --out product.json');
  return 0;
}

// --- financial-product create -----------------------------------------------

export interface ProductCreateOptions extends ProductCommandOptions {
  out?: string;
  productId?: string;
}

export async function runProductCreate(
  templateId: string,
  options: ProductCreateOptions,
  output: Output,
): Promise<number> {
  const template = findTemplate(templateId);

  if (!template) {
    output.error(`No template "${templateId}".`);
    output.blank();
    output.detail(`  Available: ${PRODUCT_TEMPLATES.map((entry) => entry.id).join(', ')}`);
    return 1;
  }

  const definition = template.build();
  const withId = options.productId ? { ...definition, productId: options.productId } : definition;

  const target = options.out ?? `${withId.productId}.json`;

  await writeFile(resolve(target), `${JSON.stringify(withId, null, 2)}\n`, 'utf8');

  output.success(`Wrote ${target} from the "${templateId}" template.`);
  output.blank();
  output.detail('  It already validates. What it does not have is a connector for each');
  output.detail('  provider interface, and it is denominated in XTS — the ISO 4217 testing');
  output.detail('  code — so nothing settles until both are changed deliberately.');
  output.blank();
  output.detail(`  Next: trustos financial-product validate ${target}`);
  return 0;
}

// --- financial-product validate ---------------------------------------------

export async function runProductValidate(
  path: string,
  options: ProductCommandOptions,
  output: Output,
): Promise<number> {
  const definition = await readDefinition(path, output);
  if (!definition) return 1;

  const result = validateProduct(definition, { referenceData: structuralReferenceData() });
  const governance = assessGovernance(definition, new Date());

  if (options.json) {
    output.info(json({
      productId: definition.productId,
      version: definition.version,
      valid: result.valid,
      findings: result.findings,
      executionOrder: result.executionOrder,
      governance: governance.findings,
    }));
    return result.valid ? 0 : 1;
  }

  output.info(style.bold(`${definition.productName} ${definition.version}`));
  output.blank();

  if (result.findings.length === 0) {
    output.success('  No findings.');
  } else {
    printFindings(result.findings, output);
  }

  if (governance.findings.length > 0) {
    output.blank();
    output.info(style.bold('Governance'));
    for (const finding of governance.findings) {
      const line = `  ${finding.area}  ${finding.message}`;
      if (finding.severity === 'breach' || finding.severity === 'overdue') output.error(line);
      else output.warn(line);
    }
  }

  if (options.verbose && result.executionOrder.length > 0) {
    output.blank();
    output.info(style.bold('Execution order'));
    output.detail(`  ${result.executionOrder.join(' -> ')}`);
  }

  output.blank();
  if (result.valid) {
    output.success('  Valid.');
    output.detail('  Validation is a static check. It cannot see a handler that is not bound,');
    output.detail('  a connector that is not approved, or a provider that is down.');
  } else {
    output.error('  Not valid.');
  }

  return result.valid ? 0 : 1;
}

// --- financial-product simulate ---------------------------------------------

export interface ProductSimulateOptions extends ProductCommandOptions {
  count?: string;
  seed?: string;
}

export async function runProductSimulate(
  path: string,
  options: ProductSimulateOptions,
  output: Output,
): Promise<number> {
  const definition = await readDefinition(path, output);
  if (!definition) return 1;

  const validation = validateProduct(definition);
  if (!validation.valid) {
    output.error('The product does not validate. Simulating it would measure a product nobody can run.');
    output.blank();
    printFindings(validation.findings, output);
    return 1;
  }

  const count = Number.parseInt(options.count ?? '1000', 10);
  const seed = Number.parseInt(options.seed ?? '1', 10);

  if (!Number.isFinite(count) || count < 1 || count > 1_000_000) {
    output.error('--count must be between 1 and 1,000,000.');
    return 1;
  }

  /*
   * The definition is published locally, in memory, purely so the simulator can bind a version.
   *
   * It is never written anywhere. Binding is what carries the content hash into the execution
   * records, and a simulator that skipped it would be simulating a path the runtime does not take.
   */
  const version = publishVersion({
    definition: { ...definition, lifecycleStatus: 'active' },
    organizationId: null,
    publishedById: 'cli',
    authoredById: 'cli-author',
    approvedBy: [{ level: 'PRODUCT_OWNER', actorId: 'cli-approver' }],
    supersedes: null,
    changeSummary: 'Published in memory by the CLI so the simulator can bind a version.',
    changedPaths: [],
    now: new Date(0),
  });

  const report = await simulate({ version, count, seed, resetBalanceEvery: 1 });

  if (options.json) {
    output.info(json(report));
    return 0;
  }

  for (const line of formatReport(report)) output.detail(line);
  return 0;
}

// --- financial-product publish (a plan) --------------------------------------

export interface ProductPublishOptions extends ProductCommandOptions {
  previous?: string;
}

export async function runProductPublishPlan(
  path: string,
  options: ProductPublishOptions,
  output: Output,
): Promise<number> {
  const definition = await readDefinition(path, output);
  if (!definition) return 1;

  const previous = options.previous ? await readDefinition(options.previous, output) : null;
  if (options.previous && !previous) return 1;

  const validation = validateProduct(definition, { referenceData: structuralReferenceData() });
  const classification = classifyChange(previous, definition);
  const governance = assessGovernance(definition, new Date());

  const blockers = [
    ...validation.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.subject}: ${finding.message}`),
    ...governance.findings
      .filter((finding) => finding.severity === 'breach' || finding.severity === 'overdue')
      .map((finding) => finding.message),
  ];

  if (options.json) {
    output.info(json({
      productId: definition.productId,
      version: definition.version,
      wouldSucceed: blockers.length === 0,
      requiredApprovalLevels: classification.requiredApprovalLevels,
      changedPaths: classification.changedPaths,
      blockers,
      wrote: null,
    }));
    return blockers.length === 0 ? 0 : 1;
  }

  output.info(style.bold(`Publication plan — ${definition.productName} ${definition.version}`));
  output.blank();
  output.warn('  Nothing was written. Publishing needs a registry, an actor and an approval');
  output.warn('  trail, none of which exist on a laptop. This is what the request would face.');
  output.blank();

  output.info(style.bold('What changed'));
  if (!previous) {
    output.detail('  A new product. Every field it declares is a change, so every approval applies.');
  } else if (classification.changedPaths.length === 0) {
    output.detail('  Nothing. This version is identical to the previous one.');
  } else {
    for (const line of classification.summary) output.detail(`  ${line}`);
  }

  output.blank();
  output.info(style.bold('Approvals required'));
  if (classification.requiredApprovalLevels.length === 0) {
    output.detail('  None. Nothing sensitive changed.');
  } else {
    for (const level of classification.requiredApprovalLevels) output.detail(`  ${level}`);
    output.blank();
    output.detail('  Each from a different person, and none of them the author.');
  }

  output.blank();
  if (blockers.length === 0) {
    output.success('  Nothing would block this publication.');
  } else {
    output.error(`  ${blockers.length} blocker(s):`);
    for (const blocker of blockers) output.error(`    ${blocker}`);
  }

  return blockers.length === 0 ? 0 : 1;
}

// --- financial-product versions ---------------------------------------------

export async function runProductVersions(
  paths: string[],
  options: ProductCommandOptions,
  output: Output,
): Promise<number> {
  const definitions: ProductDefinition[] = [];

  for (const path of paths) {
    const definition = await readDefinition(path, output);
    if (!definition) return 1;
    definitions.push(definition);
  }

  const sorted = [...definitions].sort((left, right) => left.version.localeCompare(right.version));

  const rows = sorted.map((definition, index) => {
    const previous = index === 0 ? null : (sorted[index - 1] as ProductDefinition);
    const classification = classifyChange(previous, definition);

    /*
     * A first version changes everything, and printing all twenty-two field names produces a
     * row nobody reads. The count says the same thing and leaves the column usable for the
     * versions that follow — which are the ones somebody is comparing.
     */
    const changed =
      previous === null
        ? `(first version — ${classification.changedPaths.length} fields)`
        : classification.changedPaths.join(', ') || '(no material change)';

    return [
      definition.version,
      definition.lifecycleStatus,
      changed,
      classification.requiredApprovalLevels.join(', ') || 'none',
    ];
  });

  if (options.json) {
    output.info(json(
      sorted.map((definition, index) => ({
        version: definition.version,
        lifecycleStatus: definition.lifecycleStatus,
        ...classifyChange(index === 0 ? null : (sorted[index - 1] as ProductDefinition), definition),
      })),
    ));
    return 0;
  }

  output.info(style.bold(`${sorted[0]?.productName ?? 'Product'} — versions`));
  output.blank();
  output.info(table([['VERSION', 'STATUS', 'CHANGED', 'APPROVALS'], ...rows]));
  return 0;
}

// --- financial-product rollback (a plan) -------------------------------------

export async function runProductRollbackPlan(
  fromPath: string,
  toPath: string,
  options: ProductCommandOptions,
  output: Output,
): Promise<number> {
  const current = await readDefinition(fromPath, output);
  const target = await readDefinition(toPath, output);
  if (!current || !target) return 1;

  if (current.productId !== target.productId) {
    output.error(`Cannot roll ${current.productId} back to a version of ${target.productId}.`);
    return 1;
  }

  const differences = classifyChange(target, current);

  if (options.json) {
    output.info(json({
      productId: current.productId,
      from: current.version,
      to: target.version,
      revertedPaths: differences.changedPaths,
      wrote: null,
    }));
    return 0;
  }

  output.info(style.bold(`Rollback plan — ${current.productId}`));
  output.blank();
  output.warn('  Nothing was written. This is what a rollback would change.');
  output.blank();
  output.detail(`  New transactions would start on ${target.version} instead of ${current.version}.`);
  output.detail(`  Executions already bound to ${current.version} finish on it.`);
  output.detail('  Completed transactions keep recording the version they ran under.');
  output.detail('  Nothing historical is rewritten.');
  output.blank();

  output.info(style.bold('What reverts'));
  if (differences.changedPaths.length === 0) {
    output.detail('  Nothing. The two versions are materially identical.');
  } else {
    for (const path of differences.changedPaths) output.detail(`  ${path}`);
  }

  return 0;
}

// --- financial-product doctor ------------------------------------------------

export interface ProductDoctorFinding {
  area: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  detail: string;
  remediation?: string;
}

export async function runProductDoctor(
  path: string | undefined,
  options: ProductCommandOptions,
  output: Output,
): Promise<number> {
  const findings: ProductDoctorFinding[] = [];

  if (!path) {
    output.error('Pass a product definition: trustos financial-product doctor <file>');
    return 1;
  }

  const definition = await readDefinition(path, output);
  if (!definition) return 1;

  const validation = validateProduct(definition, { referenceData: structuralReferenceData() });
  const governance = assessGovernance(definition, new Date());

  findings.push({
    area: 'validation',
    status: validation.valid ? 'PASS' : 'FAIL',
    detail: validation.valid
      ? 'The composition is structurally sound.'
      : `${validation.findings.filter((finding) => finding.severity === 'error').length} error(s).`,
    ...(validation.valid ? {} : { remediation: 'Run `trustos financial-product validate` for detail.' }),
  });

  const unbound = definition.providers.filter((provider) => !provider.connectorId);
  findings.push({
    area: 'providers',
    status: unbound.length === 0 ? 'PASS' : 'WARN',
    detail:
      unbound.length === 0
        ? `${definition.providers.length} provider interface(s), all bound.`
        : `${unbound.length} unbound: ${unbound.map((provider) => provider.providerInterface).join(', ')}.`,
    ...(unbound.length === 0
      ? {}
      : { remediation: 'Bind an approved connector before publication.' }),
  });

  /*
   * The currency check that catches a template deployed unchanged.
   *
   * XTS is the ISO 4217 testing code. A product still denominated in it has never been
   * configured, and it will pass every other check here.
   */
  const testCurrency = definition.supportedCurrencies.includes('XTS');
  findings.push({
    area: 'currency',
    status: testCurrency ? 'FAIL' : 'PASS',
    detail: testCurrency
      ? 'Still denominated in XTS, the ISO 4217 testing code. This is a template nobody configured.'
      : `Denominated in ${definition.supportedCurrencies.join(', ')}.`,
    ...(testCurrency ? { remediation: 'Set supportedCurrencies to what this product settles in.' } : {}),
  });

  /*
   * Only blocks that actually move money.
   *
   * Counting every block with `onFailure: 'fail'` reports eight on a product where seven of them
   * are lookups and limit checks — a finding that is technically true, is noise, and teaches the
   * reader to skip this row.
   */
  const compensators = new Set(definition.blocks.flatMap((block) => block.compensateWith));

  const uncompensated = definition.blocks.filter((block) => {
    if (block.onFailure !== 'fail') return false;
    // A compensator that fails ends the execution in `compensation_failed`, which is a state
    // with a person at the end of it rather than a missing control.
    if (compensators.has(block.key)) return false;
    const catalog = APPROVED_BLOCKS.find(block.blockId, block.blockVersion);
    return catalog?.monetaryEffect === 'moves';
  });

  findings.push({
    area: 'compensation',
    status: uncompensated.length === 0 ? 'PASS' : 'WARN',
    detail:
      uncompensated.length === 0
        ? 'Every money-moving block declares what undoes it.'
        : `${uncompensated.length} money-moving block(s) fail without compensating: ` +
          `${uncompensated.map((block) => block.key).join(', ')}.`,
    ...(uncompensated.length === 0
      ? {}
      : { remediation: 'A failure leaves the movement in place for somebody to unwind by hand.' }),
  });

  findings.push({
    area: 'governance',
    status: governance.healthy ? 'PASS' : 'FAIL',
    detail: governance.healthy
      ? `Review due in ${governance.daysUntilReview} day(s).`
      : governance.findings.map((finding) => finding.message).join(' '),
  });

  const exposed = definition.apiExposurePolicy.exposed;
  const unkeyed = definition.apiExposurePolicy.operations.filter(
    (operation) => operation.createsTransaction && !operation.requiresIdempotencyKey,
  );
  findings.push({
    area: 'api exposure',
    status: !exposed ? 'INFO' : unkeyed.length === 0 ? 'PASS' : 'FAIL',
    detail: !exposed
      ? 'Not exposed over an API.'
      : `${definition.apiExposurePolicy.operations.length} operation(s), ${unkeyed.length} without an idempotency key.`,
  });

  const ok = !findings.some((finding) => finding.status === 'FAIL');

  if (options.json) {
    output.info(json({ productId: definition.productId, version: definition.version, findings, ok }));
    return ok ? 0 : 1;
  }

  output.info(style.bold(`${definition.productName} ${definition.version}`));
  output.blank();
  output.info(table(findings.map((finding) => [finding.status, finding.area, finding.detail])));

  const remediations = findings.filter((finding) => finding.remediation);
  if (remediations.length > 0) {
    output.blank();
    output.info(style.bold('What to do'));
    for (const finding of remediations) output.detail(`  ${finding.area}: ${finding.remediation}`);
  }

  output.blank();
  if (ok) output.success('  No failures.');
  else output.error('  Failures above.');

  return ok ? 0 : 1;
}

// --- financial-block list ----------------------------------------------------

export interface BlockListOptions extends ProductCommandOptions {
  category?: string;
}

export function runBlockList(options: BlockListOptions, output: Output): number {
  const registry = APPROVED_BLOCKS;

  const blocks = options.category
    ? registry.byCategory(options.category as BlockCategory)
    : registry.all();

  if (options.category && blocks.length === 0) {
    output.error(`No category "${options.category}".`);
    output.blank();
    output.detail(`  Available: ${registry.categories().join(', ')}`);
    return 1;
  }

  if (options.json) {
    output.info(json(blocks));
    return 0;
  }

  const summary = blockCatalogSummary(registry);

  output.info(style.bold('Approved financial blocks'));
  output.blank();
  output.info(
    table([
      ['BLOCK', 'VERSION', 'MONEY', 'PROVIDER', 'DESCRIPTION'],
      ...blocks
        .sort((left, right) => left.blockId.localeCompare(right.blockId))
        .map((block) => [
          block.blockId,
          block.version,
          block.monetaryEffect,
          block.providerInterface ?? '—',
          options.verbose ? block.description : block.name,
        ]),
    ]),
  );

  output.blank();
  output.detail(
    `  ${summary.total} blocks, ${Object.keys(summary.byCategory).length} categories, ` +
      `${summary.movesMoney} move money, ${summary.requiresProvider} need a provider interface.`,
  );
  output.detail('  The framework ships no handler for any of them. The seam is the deliverable.');
  return 0;
}

// --- connector list / validate ------------------------------------------------

export function runConnectorList(options: ProductCommandOptions, output: Output): number {
  if (options.json) {
    output.info(json(
      PROVIDER_INTERFACE_NAMES.map((name) => ({
        providerInterface: name,
        description: PROVIDER_INTERFACES[name].description,
        operations: PROVIDER_INTERFACES[name].operations,
      })),
    ));
    return 0;
  }

  output.info(style.bold('Provider interfaces'));
  output.blank();
  output.info(
    table(
      PROVIDER_INTERFACE_NAMES.map((name) => [
        name,
        PROVIDER_INTERFACES[name].operations.join(', '),
        PROVIDER_INTERFACES[name].description,
      ]),
    ),
  );

  output.blank();
  output.detail('  The framework ships no connectors — this catalog is empty by design.');
  output.detail('  A deployment registers its own, and they name their providers.');
  return 0;
}

export async function runConnectorValidate(
  path: string,
  options: ProductCommandOptions,
  output: Output,
): Promise<number> {
  const result = await readDocument(path);

  if ('error' in result) {
    output.error(result.error);
    return 1;
  }

  const documents = Array.isArray(result.document) ? result.document : [result.document];
  const problems: Array<{ index: number; message: string }> = [];

  for (const [index, document] of documents.entries()) {
    const parsed = connectorDefinitionSchema.safeParse(document);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({ index, message: `${issue.path.join('.') || '(root)'}: ${issue.message}` });
      }
    }
  }

  if (options.json) {
    output.info(json({ checked: documents.length, valid: problems.length === 0, problems }));
    return problems.length === 0 ? 0 : 1;
  }

  output.info(style.bold(`${documents.length} connector(s) in ${path}`));
  output.blank();

  if (problems.length === 0) {
    output.success('  Valid.');
    output.blank();
    output.detail('  A connector carries no endpoint and no credential. Both belong to the');
    output.detail('  adapter’s configuration in the deployment.');
    return 0;
  }

  for (const problem of problems) {
    output.error(`  [${problem.index}] ${problem.message}`);
  }

  return 1;
}
