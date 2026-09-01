import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  DATA_CLASSIFICATION_LEVELS,
  obligationsFor,
  type DataClassificationLevel,
} from '@trustsystem/data-classification';
import { DataCatalog, catalogEntrySchema, type CatalogEntry } from '@trustsystem/data-catalog';
import { LineageGraph, lineageEdgeSchema } from '@trustsystem/data-lineage';
import { policyDocumentSchema, type PolicyDocument } from '@trustsystem/policy-registry';
import {
  analysePolicy,
  evaluatePolicy,
  explainDecision,
  runPolicyTests,
} from '@trustsystem/policy-evaluator';
import { ServiceRegistry, runbookSchema, serviceSchema } from '@trustsystem/sre-core';
import { sloSchema } from '@trustsystem/slo';
import { ApiCatalog, apiDefinitionSchema } from '@trustsystem/api-catalog';
import { analyseCompatibility } from '@trustsystem/api-versioning';
import {
  BackupInventory,
  assuranceOf,
  backupRecordSchema,
  describeAssurance,
} from '@trustsystem/backup';
import { drPlanSchema, readinessOf, reviewPlans } from '@trustsystem/disaster-recovery';
import { style, type Output } from '../output';

/**
 * `trustos data`, `policy`, `sre`, `api`, `backup`, `dr` and `enterprise doctor`.
 *
 * All of it **read-only and offline**, like the workflow and financial-product commands. It parses
 * files, walks graphs and prints. Nothing here activates a policy, publishes an API, registers a
 * service or marks a backup validated — those need a registry, an actor and an approval trail,
 * none of which exist on a laptop.
 *
 * That constraint is load-bearing rather than incidental for this particular group. These commands
 * cover the surfaces where a bypass would be most valuable: a CLI that could activate a policy
 * would be a way to change what the platform permits without going through the console that
 * requires a second person. So the CLI reads, checks and explains, and every command that sounds
 * like it acts says plainly that it did not.
 *
 * `enterprise doctor` is the one to run before asking anybody to review anything: it takes a
 * directory of governance documents and reports what a reviewer would find.
 */

export interface EnterpriseCommandOptions {
  json?: boolean;
  verbose?: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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
 * Reads a JSON document.
 *
 * JSON only, for the reason the workflow command gives: a YAML parser in the CLI is a parser
 * reachable from a file path, and the two most widely used ones have both had deserialization
 * vulnerabilities.
 */
async function readDocument(path: string, output: Output): Promise<unknown | null> {
  const absolute = resolve(path);

  if (extname(absolute) === '.yaml' || extname(absolute) === '.yml') {
    output.error(`${path} looks like YAML. The CLI reads JSON only — convert it first.`);
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (error) {
    output.error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    output.error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function parseAll<T>(
  documents: unknown,
  parse: (input: unknown) => T,
  label: string,
  output: Output,
): T[] | null {
  const list = Array.isArray(documents) ? documents : [documents];
  const parsed: T[] = [];

  for (const [index, document] of list.entries()) {
    try {
      parsed.push(parse(document));
    } catch (error) {
      output.error(`${label} ${index} is not valid.`);
      output.detail(
        `  ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
      );
      return null;
    }
  }

  return parsed;
}

// --- trustos data catalog ----------------------------------------------------

export async function runDataCatalog(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const entries = parseAll(
    document,
    (input) => catalogEntrySchema.parse(input),
    'Catalog entry',
    output,
  );
  if (!entries) return 1;

  let catalog: DataCatalog;
  try {
    catalog = new DataCatalog(entries);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const misclassified = catalog.misclassified();
  const overdue = catalog.overdueReviews(new Date());

  if (options.json) {
    output.info(json({ entries: catalog.all(), misclassified, overdueReviews: overdue }));
    return misclassified.length > 0 ? 1 : 0;
  }

  output.info(style.bold(`Data catalog — ${catalog.size()} entries`));
  output.blank();
  output.info(
    table(
      catalog
        .all()
        .map((entry: CatalogEntry) => [
          entry.entryId,
          entry.kind,
          entry.classification,
          entry.owner,
          entry.businessName,
        ]),
    ),
  );

  if (misclassified.length > 0) {
    output.blank();
    output.warn(`  ${misclassified.length} entry(ies) classified below what their contents imply:`);
    for (const finding of misclassified) {
      output.detail(
        `    ${finding.entryId}: declared ${finding.declared}, children imply ${finding.actual}`,
      );
    }
  }

  if (overdue.length > 0) {
    output.blank();
    output.warn(`  ${overdue.length} entry(ies) overdue for review.`);
  }

  return misclassified.length > 0 ? 1 : 0;
}

// --- trustos data classify ---------------------------------------------------

export function runDataClassify(
  level: string,
  options: EnterpriseCommandOptions,
  output: Output,
): number {
  if (!DATA_CLASSIFICATION_LEVELS.includes(level as DataClassificationLevel)) {
    output.error(`"${level}" is not a classification level.`);
    output.detail(`  Levels: ${DATA_CLASSIFICATION_LEVELS.join(', ')}`);
    return 1;
  }

  const obligations = obligationsFor(level as DataClassificationLevel);

  if (options.json) {
    output.info(json(obligations));
    return 0;
  }

  /*
   * Prints what the level *obliges* rather than what it is called. A classification that is only a
   * label is a label somebody argues about; the obligations are what a reviewer actually needs.
   */
  output.info(style.bold(`${obligations.level}`));
  output.blank();
  output.detail(`  ${obligations.description}`);
  output.blank();
  output.info(
    table([
      ['Mask by default', obligations.maskByDefault ? 'yes' : 'no'],
      ['Exportable', obligations.exportable ? 'yes' : 'no'],
      ['Reveal needs approval', obligations.revealRequiresApproval ? 'yes' : 'no'],
      ['Cross-region permitted', obligations.crossRegionPermitted ? 'yes' : 'no'],
      ['Default retention', `${obligations.defaultRetentionDays} days`],
      ['Review interval', `${obligations.reviewIntervalDays} days`],
      ['May be an AI input', obligations.aiInputPermitted ? 'yes' : 'no'],
    ]),
  );

  return 0;
}

// --- trustos data lineage ----------------------------------------------------

export async function runDataLineage(
  catalogFile: string,
  lineageFile: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const catalogDocument = await readDocument(catalogFile, output);
  if (catalogDocument === null) return 1;

  const lineageDocument = await readDocument(lineageFile, output);
  if (lineageDocument === null) return 1;

  const entries = parseAll(
    catalogDocument,
    (input) => catalogEntrySchema.parse(input),
    'Catalog entry',
    output,
  );
  if (!entries) return 1;

  const edges = parseAll(
    lineageDocument,
    (input) => lineageEdgeSchema.parse(input),
    'Lineage edge',
    output,
  );
  if (!edges) return 1;

  const catalog = new DataCatalog(entries);
  const graph = new LineageGraph(edges);

  /*
   * The finding worth having: a report classified PUBLIC that is fed by a RESTRICTED table. The
   * report is a restricted extract with a public label, and nothing about the report itself says so.
   */
  const drift = graph.classificationDrift(catalog);

  if (options.json) {
    output.info(json({ edges: graph.size(), drift }));
    return drift.length > 0 ? 1 : 0;
  }

  output.info(style.bold(`Lineage — ${graph.size()} edges over ${catalog.size()} entries`));

  if (drift.length === 0) {
    output.blank();
    output.success('  Every entry is classified at least as high as what feeds it.');
    return 0;
  }

  output.blank();
  output.warn(`  ${drift.length} entry(ies) classified below what feeds them:`);
  for (const finding of drift) {
    output.detail(
      `    ${finding.entryId}: declared ${finding.declared}, upstream implies ${finding.propagated}`,
    );
    if (options.verbose) {
      output.detail(`      from: ${graph.upstreamOf(finding.entryId).join(', ')}`);
    }
  }

  return 1;
}

// --- trustos policy ----------------------------------------------------------

async function readPolicies(file: string, output: Output): Promise<PolicyDocument[] | null> {
  const document = await readDocument(file, output);
  if (document === null) return null;
  return parseAll(document, (input) => policyDocumentSchema.parse(input), 'Policy', output);
}

export async function runPolicyList(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const policies = await readPolicies(file, output);
  if (!policies) return 1;

  if (options.json) {
    output.info(
      json(
        policies.map((policy) => ({
          policyId: policy.policyId,
          version: policy.version,
          status: policy.status,
          category: policy.category,
          rules: policy.rules.length,
          testCases: policy.testCases.length,
        })),
      ),
    );
    return 0;
  }

  output.info(style.bold(`Policies — ${policies.length}`));
  output.blank();
  output.info(
    table(
      policies.map((policy) => [
        policy.policyId,
        policy.version,
        policy.status,
        policy.category,
        `${policy.rules.length} rules`,
      ]),
    ),
  );

  return 0;
}

export async function runPolicyValidate(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const policies = await readPolicies(file, output);
  if (!policies) return 1;

  let failed = 0;

  for (const policy of policies) {
    const tests = runPolicyTests(policy);
    const findings = analysePolicy(policy);
    const errors = findings.filter((finding) => finding.severity === 'error');

    if (options.json) continue;

    output.info(style.bold(`${policy.policyId}@${policy.version}`));

    if (tests.passed && errors.length === 0) {
      output.success(`  ${tests.results.length} test(s) pass; static analysis is clean.`);
    } else {
      failed += 1;

      for (const result of tests.results.filter((entry) => !entry.passed)) {
        output.error(`  test "${result.name}": expected ${result.expected}, got ${result.actual}`);
      }

      for (const finding of findings) {
        const line = `  ${finding.code} on ${finding.ruleId}: ${finding.message}`;
        if (finding.severity === 'error') output.error(line);
        else output.warn(line);
      }
    }

    output.blank();
  }

  if (options.json) {
    output.info(
      json(
        policies.map((policy) => ({
          policyId: policy.policyId,
          version: policy.version,
          tests: runPolicyTests(policy),
          findings: analysePolicy(policy),
        })),
      ),
    );
  }

  return failed > 0 ? 1 : 0;
}

export async function runPolicySimulate(
  file: string,
  attributesJson: string,
  options: EnterpriseCommandOptions & { policyId?: string },
  output: Output,
): Promise<number> {
  const policies = await readPolicies(file, output);
  if (!policies) return 1;

  let attributes: Record<string, never>;
  try {
    attributes = JSON.parse(attributesJson) as Record<string, never>;
  } catch (error) {
    output.error(
      `The attributes are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const policy = options.policyId
    ? policies.find((candidate) => candidate.policyId === options.policyId)
    : policies[0];

  if (!policy) {
    output.error(`No policy called ${options.policyId ?? '(first in file)'} in ${file}.`);
    return 1;
  }

  /*
   * Simulates a draft as readily as an active policy. That is the point of simulating — a policy
   * whose behaviour can only be observed after activation is a policy nobody can review — and it
   * is safe here precisely because the CLI cannot enforce anything.
   */
  const decision = evaluatePolicy(policy, attributes);

  if (options.json) {
    output.info(json(decision));
    return decision.decision === 'ALLOW' ? 0 : 2;
  }

  for (const line of explainDecision(decision)) {
    output.info(line);
  }

  if (decision.missingAttributes.length > 0) {
    output.blank();
    output.warn(
      `  ${decision.missingAttributes.length} attribute(s) the policy reads were not supplied: ` +
        `${decision.missingAttributes.join(', ')}.`,
    );
    output.detail(
      '    A rule reading a missing attribute never fires, which looks like a rule that never needed to.',
    );
  }

  if (policy.status !== 'active') {
    output.blank();
    output.detail(`  This policy is "${policy.status}". Simulating it here enforces nothing.`);
  }

  return decision.decision === 'ALLOW' ? 0 : 2;
}

// --- trustos sre -------------------------------------------------------------

export async function runSreServices(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const input = document as { services?: unknown; runbooks?: unknown };

  const runbooks = parseAll(
    input.runbooks ?? [],
    (entry) => runbookSchema.parse(entry),
    'Runbook',
    output,
  );
  if (!runbooks) return 1;

  const services = parseAll(
    input.services ?? document,
    (entry) => serviceSchema.parse(entry),
    'Service',
    output,
  );
  if (!services) return 1;

  let registry: ServiceRegistry;
  try {
    registry = new ServiceRegistry({ runbooks, services });
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const findings = registry.analyse();

  if (options.json) {
    output.info(json({ services: registry.list(), findings }));
    return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
  }

  output.info(style.bold(`Services — ${services.length}`));
  output.blank();
  output.info(
    table(
      registry
        .list()
        .map((service) => [
          service.serviceId,
          service.tier,
          service.ownerTeam,
          service.onCallRotation ?? '(no rotation)',
          `${registry.dependents(service.serviceId).length} dependents`,
        ]),
    ),
  );

  if (findings.length > 0) {
    output.blank();
    for (const finding of findings) {
      const line = `  ${finding.serviceId}: ${finding.detail}`;
      if (finding.severity === 'high') output.error(line);
      else output.warn(line);
    }
  }

  return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
}

export async function runSreSlo(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const slos = parseAll(document, (input) => sloSchema.parse(input), 'Objective', output);
  if (!slos) return 1;

  if (options.json) {
    output.info(json(slos));
    return 0;
  }

  output.info(style.bold(`Objectives — ${slos.length}`));
  output.blank();
  output.info(
    table(
      slos.map((slo) => [
        slo.sloId,
        `${slo.target}%`,
        `${slo.windowDays}d`,
        slo.status,
        slo.status === 'committed' ? 'a commitment' : 'measured, not promised',
      ]),
    ),
  );

  output.blank();
  output.detail(
    '  A pilot objective is measured and reported. It is not something anybody may rely on.',
  );
  output.detail('  Error budgets need measurements; this command reads definitions only.');

  return 0;
}

// --- trustos api -------------------------------------------------------------

export async function runApiCatalog(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const apis = parseAll(document, (input) => apiDefinitionSchema.parse(input), 'API', output);
  if (!apis) return 1;

  const catalog = new ApiCatalog(apis);
  const findings = catalog.analyse();

  if (options.json) {
    output.info(json({ apis, findings }));
    return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
  }

  output.info(style.bold(`APIs — ${apis.length}`));
  output.blank();
  output.info(
    table(
      apis.map((api) => [
        `${api.apiId}@${api.version}`,
        api.lifecycle,
        api.environment,
        api.businessOwnerId,
        `${api.operations.length} operations`,
      ]),
    ),
  );

  if (findings.length > 0) {
    output.blank();
    for (const finding of findings) {
      const line = `  ${finding.apiId}: ${finding.detail}`;
      if (finding.severity === 'high') output.error(line);
      else output.warn(line);
    }
  }

  return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
}

export async function runApiCompatibility(
  fromFile: string,
  toFile: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const fromDocument = await readDocument(fromFile, output);
  if (fromDocument === null) return 1;

  const toDocument = await readDocument(toFile, output);
  if (toDocument === null) return 1;

  let analysis;
  try {
    analysis = analyseCompatibility(
      apiDefinitionSchema.parse(fromDocument),
      apiDefinitionSchema.parse(toDocument),
    );
  } catch (error) {
    output.error(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error));
    return 1;
  }

  if (options.json) {
    output.info(json(analysis));
    return analysis.versionSufficient ? 0 : 1;
  }

  output.info(style.bold(analysis.summary));
  output.blank();

  if (analysis.changes.length === 0) {
    output.success('  No contract differences.');
    return 0;
  }

  for (const change of analysis.changes) {
    const line = `  ${change.kind}${change.operationId ? ` (${change.operationId})` : ''}: ${change.detail}`;
    if (change.compatibility === 'breaking') output.error(line);
    else if (change.compatibility === 'additive') output.info(line);
    else output.detail(line);

    if (change.consumerAction) output.detail(`    consumers: ${change.consumerAction}`);
  }

  output.blank();

  if (!analysis.versionSufficient) {
    /*
     * The check the whole command exists for. A breaking change released as a patch is the silent
     * break the specification names, and it is the one that reads as harmless in a diff.
     */
    output.error(
      `  These changes require a ${analysis.requiredBump} version. ` +
        `${analysis.fromVersion} → ${analysis.toVersion} is not one.`,
    );
    return 1;
  }

  output.success(`  The version bump is sufficient for these changes.`);
  return 0;
}

// --- trustos backup ----------------------------------------------------------

export async function runBackupStatus(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const records = parseAll(document, (input) => backupRecordSchema.parse(input), 'Backup', output);
  if (!records) return 1;

  const inventory = new BackupInventory(records);
  const findings = inventory.analyse(new Date());

  if (options.json) {
    output.info(
      json({
        backups: records.map((backup) => ({ ...backup, assurance: assuranceOf(backup) })),
        findings,
      }),
    );
    return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
  }

  output.info(style.bold(`Backups — ${records.length}`));
  output.blank();

  /*
   * Prints the *statement* rather than a status word. "Healthy" would be shorter and would let a
   * reader conclude that a job which exited zero is a backup they can restore from.
   */
  for (const backup of records) {
    const assurance = assuranceOf(backup);
    const line = `  ${describeAssurance(backup)}`;
    if (assurance.fullyValidated) output.success(line);
    else if (backup.failureReason) output.error(line);
    else output.warn(line);
  }

  if (findings.length > 0) {
    output.blank();
    for (const finding of findings) {
      const line = `  ${finding.backupId}: ${finding.detail}`;
      if (finding.severity === 'high') output.error(line);
      else output.warn(line);
    }
  }

  return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
}

export async function runBackupVerify(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const records = parseAll(document, (input) => backupRecordSchema.parse(input), 'Backup', output);
  if (!records) return 1;

  const unvalidated = records.filter((backup) => !assuranceOf(backup).fullyValidated);

  if (options.json) {
    output.info(
      json({
        total: records.length,
        fullyValidated: records.length - unvalidated.length,
        outstanding: unvalidated.map((backup) => ({
          backupId: backup.backupId,
          outstanding: assuranceOf(backup).outstanding,
        })),
      }),
    );
    return unvalidated.length > 0 ? 1 : 0;
  }

  /*
   * This command does not verify anything — it reports what has been verified. Verifying a backup
   * means reading it back and restoring it, which needs the backup, the target and the time, none
   * of which a CLI on a laptop has. The name is what people will type; the output says what it did.
   */
  output.info(style.bold('What the recorded evidence supports'));
  output.blank();
  output.detail('  This reads the inventory. It does not read a backup, and it restores nothing.');
  output.blank();

  if (unvalidated.length === 0) {
    output.success(`  All ${records.length} backup(s) have been restored from and checked.`);
    return 0;
  }

  for (const backup of unvalidated) {
    output.warn(`  ${backup.backupId}`);
    for (const item of assuranceOf(backup).outstanding) {
      output.detail(`    ${item}`);
    }
  }

  return 1;
}

// --- trustos dr --------------------------------------------------------------

export async function runDrStatus(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const plans = parseAll(document, (input) => drPlanSchema.parse(input), 'DR plan', output);
  if (!plans) return 1;

  const findings = reviewPlans({ plans });

  if (options.json) {
    output.info(json({ plans: plans.map((plan) => readinessOf(plan)), findings }));
    return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
  }

  output.info(style.bold(`DR plans — ${plans.length}`));
  output.blank();

  for (const plan of plans) {
    const readiness = readinessOf(plan);
    const line = `  ${plan.planId} (${plan.scenario}): ${readiness.statement}`;

    if (readiness.exercisedFully && readiness.meetsRto) output.success(line);
    else if (readiness.exercised) output.warn(line);
    else output.error(line);
  }

  if (findings.length > 0) {
    output.blank();
    for (const finding of findings) {
      const line = `  ${finding.planId ?? 'estate'}: ${finding.detail}`;
      if (finding.severity === 'high') output.error(line);
      else output.warn(line);
    }
  }

  return findings.some((finding) => finding.severity === 'high') ? 1 : 0;
}

export async function runDrValidate(
  file: string,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const document = await readDocument(file, output);
  if (document === null) return 1;

  const plans = parseAll(document, (input) => drPlanSchema.parse(input), 'DR plan', output);
  if (!plans) return 1;

  const problems: string[] = [];

  for (const plan of plans) {
    const readiness = readinessOf(plan);

    if (!readiness.exercised) {
      problems.push(`${plan.planId}: never exercised, so nothing is known about whether it works.`);
    } else if (!readiness.exercisedFully) {
      problems.push(`${plan.planId}: exercised as a walkthrough only — read, not run.`);
    } else if (readiness.meetsRto === false) {
      problems.push(
        `${plan.planId}: achieved ${readiness.achievedMinutes} minutes against a ${plan.rtoMinutes}-minute RTO.`,
      );
    }
  }

  if (options.json) {
    output.info(json({ plans: plans.length, problems }));
    return problems.length > 0 ? 1 : 0;
  }

  output.info(style.bold('Can these plans be claimed as tested?'));
  output.blank();

  if (problems.length === 0) {
    output.success(
      `  All ${plans.length} plan(s) have been exercised end to end within their RTO.`,
    );
    return 0;
  }

  for (const problem of problems) {
    output.error(`  ${problem}`);
  }

  output.blank();
  output.detail('  A DR capability is what has been demonstrated, not what has been written down.');
  return 1;
}

// --- trustos enterprise doctor -----------------------------------------------

export interface EnterpriseDoctorInput {
  catalog?: string;
  lineage?: string;
  policies?: string;
  services?: string;
  apis?: string;
  backups?: string;
  drPlans?: string;
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string;
}

/**
 * The check worth running before asking anybody to review anything.
 *
 * A file that was not supplied is `skipped`, and skipped is **not** a pass. That distinction is
 * the whole value of the command: a doctor that reported "6 checks passed" when four of them had
 * no input would be a doctor that certifies an empty directory.
 */
export async function runEnterpriseDoctor(
  input: EnterpriseDoctorInput,
  options: EnterpriseCommandOptions,
  output: Output,
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const silent: Output = {
    info: () => {},
    detail: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    blank: () => {},
  };

  const run = async (
    name: string,
    file: string | undefined,
    fn: (path: string) => Promise<number>,
    skipDetail: string,
  ): Promise<void> => {
    if (!file) {
      checks.push({ name, status: 'skipped', detail: skipDetail });
      return;
    }

    const code = await fn(file);
    checks.push({
      name,
      status: code === 0 ? 'pass' : 'fail',
      detail: code === 0 ? 'No blocking findings.' : `See: ${name.toLowerCase()} for the detail.`,
    });
  };

  await run(
    'Data catalog',
    input.catalog,
    (path) => runDataCatalog(path, { json: true }, silent),
    'No catalog supplied. Nothing is known about how data is classified.',
  );

  await run(
    'Lineage',
    input.catalog && input.lineage ? input.lineage : undefined,
    (path) => runDataLineage(input.catalog as string, path, { json: true }, silent),
    'No lineage supplied. A report classified below what feeds it would not be found.',
  );

  await run(
    'Policies',
    input.policies,
    (path) => runPolicyValidate(path, { json: true }, silent),
    'No policies supplied. Nothing is known about what the platform permits.',
  );

  await run(
    'Services',
    input.services,
    (path) => runSreServices(path, { json: true }, silent),
    'No service registry supplied. Nothing is known about what is monitored or who is woken.',
  );

  await run(
    'APIs',
    input.apis,
    (path) => runApiCatalog(path, { json: true }, silent),
    'No API catalog supplied. Nothing is known about who may call what.',
  );

  await run(
    'Backups',
    input.backups,
    (path) => runBackupVerify(path, { json: true }, silent),
    'No backup inventory supplied. Nothing is known about whether anything can be restored.',
  );

  await run(
    'DR plans',
    input.drPlans,
    (path) => runDrValidate(path, { json: true }, silent),
    'No DR plans supplied. Nothing is known about whether recovery has ever been rehearsed.',
  );

  const failed = checks.filter((check) => check.status === 'fail');
  const skipped = checks.filter((check) => check.status === 'skipped');

  if (options.json) {
    output.info(json({ checks, failed: failed.length, skipped: skipped.length }));
    return failed.length > 0 ? 1 : 0;
  }

  output.info(style.bold('Enterprise governance'));
  output.blank();

  for (const check of checks) {
    const line = `  ${check.name.padEnd(14)} ${check.detail}`;
    if (check.status === 'pass') output.success(line);
    else if (check.status === 'fail') output.error(line);
    else output.detail(`  ${check.name.padEnd(14)} skipped — ${check.detail}`);
  }

  output.blank();

  if (skipped.length > 0) {
    /*
     * Stated as plainly as the failures. "5 checks passed" over a directory with two files is the
     * sentence that ends up in a readiness report, and it is not true.
     */
    output.warn(
      `  ${skipped.length} of ${checks.length} check(s) had no input. A check that did not run is not a check that passed.`,
    );
  }

  if (failed.length > 0) {
    output.error(`  ${failed.length} check(s) found blocking issues.`);
    return 1;
  }

  if (skipped.length === checks.length) {
    output.error('  Nothing was checked.');
    return 1;
  }

  output.success(`  ${checks.length - skipped.length - failed.length} check(s) passed.`);
  return 0;
}
