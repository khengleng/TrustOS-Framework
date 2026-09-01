import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MODULE_CATALOG } from '@trustsystem/module-registry';
import { ModelRegistry, isUsable, pricingAgeDays, type Model } from '@trustsystem/model-registry';
import { AgentRegistry } from '@trustsystem/agent-framework';
import {
  promptVersionSchema,
  referencedComponents,
  referencedVariables,
  validateTemplateSyntax,
} from '@trustsystem/prompt-registry';
import { EvaluationService, evaluationSuiteSchema } from '@trustsystem/evaluation';
import { formatRows, style, type Output } from '../output';

/**
 * `trustos ai` — the AI platform's command group.
 *
 * Every subcommand here is **offline**. No database, no network, no model call, no credentials.
 * That is a deliberate limit rather than an unfinished feature, and it is what makes the group
 * useful: these are the questions somebody asks on a laptop, in a checkout, usually while
 * something is wrong. A command that needed a running application and an API key could not be
 * run then.
 *
 * It also means `trustos ai evaluate` cannot call a model. It validates suites and compares
 * recorded runs, and it says so rather than implying it measured something. The evaluation that
 * calls models runs inside the application, which is where the credentials and the gateway are.
 *
 * The files these read are conventions, not requirements — an application is free to configure
 * models and agents in code. Where a file is missing, the command says what it would have read
 * and moves on rather than failing.
 */

export interface AiCommandOptions {
  path?: string;
  json?: boolean;
  verbose?: boolean;
}

/** Where each subcommand looks. First match wins. */
const LOCATIONS = {
  models: ['ai/models.json', 'config/ai/models.json', 'src/ai/models.json'],
  agents: ['ai/agents.json', 'config/ai/agents.json', 'src/ai/agents.json'],
  prompts: ['ai/prompts', 'config/ai/prompts', 'src/ai/prompts'],
  evaluations: ['ai/evaluations', 'config/ai/evaluations', 'src/ai/evaluations'],
};

const AI_MODULE_IDS = ['ai', 'rag', 'agent'];

// ---------------------------------------------------------------------------
// ai doctor
// ---------------------------------------------------------------------------

export interface AiFinding {
  area: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  detail: string;
  remediation?: string;
}

export interface AiDoctorReport {
  applicationRoot: string | null;
  installed: string[];
  findings: AiFinding[];
  ok: boolean;
}

export async function runAiDoctor(options: AiCommandOptions, output: Output): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());

  if (!applicationRoot) {
    return noApplication(output);
  }

  const packageJson = await readJson(join(applicationRoot, 'package.json'));
  const dependencies = {
    ...((packageJson?.dependencies as Record<string, string>) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string>) ?? {}),
  };

  const installed = AI_MODULE_IDS.filter((id) => `@trustsystem/module-${id}` in dependencies);
  const findings: AiFinding[] = [];

  if (installed.length === 0) {
    findings.push({
      area: 'installed modules',
      status: 'INFO',
      detail: 'No AI modules are installed.',
      remediation: 'Install one with: trustos add-module ai|rag|agent',
    });
  } else {
    findings.push({
      area: 'installed modules',
      status: 'PASS',
      detail: `${installed.length} installed: ${installed.join(', ')}.`,
    });
  }

  findings.push(...checkDependencies(installed));
  findings.push(...(await checkWiring(applicationRoot, installed)));
  findings.push(...(await checkSchema(applicationRoot, installed)));
  findings.push(...(await checkModels(applicationRoot, installed)));
  findings.push(...(await checkAgents(applicationRoot, installed)));
  findings.push(...(await checkSecrets(applicationRoot, installed)));

  const report: AiDoctorReport = {
    applicationRoot,
    installed,
    findings,
    ok: findings.every((finding) => finding.status !== 'FAIL'),
  };

  if (options.json) {
    output.info(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  printFindings('AI platform', report, output, options.verbose === true);
  return report.ok ? 0 : 1;
}

function checkDependencies(installed: string[]): AiFinding[] {
  const present = new Set(installed);
  const findings: AiFinding[] = [];

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;

    for (const dependency of entry.dependencies) {
      if (present.has(dependency.moduleId)) continue;

      findings.push({
        area: `${id} dependencies`,
        status: 'FAIL',
        detail: `${id} needs ${dependency.moduleId}, which is not installed. ${dependency.reason}`,
        remediation: `trustos add-module ${dependency.moduleId}`,
      });
    }
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'module dependencies',
      status: 'PASS',
      detail: 'Every installed AI module has its dependencies.',
    });
  }

  return findings;
}

async function checkWiring(applicationRoot: string, installed: string[]): Promise<AiFinding[]> {
  if (installed.length === 0) return [];

  const sources = await readCompositionRoots(applicationRoot);

  if (sources === null) {
    return [
      {
        area: 'wiring',
        status: 'WARN',
        detail: 'No composition root found, so AI wiring could not be checked.',
      },
    ];
  }

  const findings: AiFinding[] = [];

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;
    if (sources.includes(entry.packaging.nestModule.importPath)) continue;

    findings.push({
      area: `${id} wiring`,
      status: 'FAIL',
      detail: `${id} is installed but never imported, so it does nothing.`,
      remediation:
        `Import ${entry.packaging.nestModule.className} from ` +
        `'${entry.packaging.nestModule.importPath}' in the composition root.`,
    });
  }

  /*
   * The gateway needs a provider adapter, and the framework ships none.
   *
   * Without one, every request fails at the last step — after policy, guardrails and routing have
   * all passed. The error is clear enough at runtime; the point of checking here is that it is
   * found before the first request rather than by it.
   */
  // Names specific to an adapter. An earlier version also matched `providers: [`, which every
  // Nest module has — so every generated application passed this check while having no adapter
  // at all, which is precisely the state it exists to find.
  const ADAPTER_SIGNS = /registerAdapter|AiProviderAdapter|adapters\s*:/;

  if (installed.includes('ai') && !ADAPTER_SIGNS.test(sources)) {
    findings.push({
      area: 'provider adapter',
      status: 'WARN',
      detail:
        'No provider adapter registration found. The framework ships none, so the gateway has ' +
        'nothing to call.',
      remediation:
        'Write an adapter implementing AiProviderAdapter and register it on the gateway. See ' +
        'docs/ai-architecture.md.',
    });
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'wiring',
      status: 'PASS',
      detail: 'Every installed AI module is imported.',
    });
  }

  return findings;
}

async function checkSchema(applicationRoot: string, installed: string[]): Promise<AiFinding[]> {
  if (installed.length === 0) return [];

  const schemaPath = join(applicationRoot, 'prisma/schema/00-framework.prisma');

  if (!existsSync(schemaPath)) {
    return [
      {
        area: 'schema',
        status: 'WARN',
        detail: 'No prisma/schema/00-framework.prisma, so the AI tables could not be checked.',
      },
    ];
  }

  const schema = await readFile(schemaPath, 'utf8');

  const REQUIRED: Record<string, string[]> = {
    ai: ['AiModel', 'AiPrompt', 'AiPromptVersion', 'AiPolicy', 'AiRequestLog', 'AiCacheEntry'],
    rag: ['AiKnowledgeCollection', 'AiKnowledgeDocument', 'AiVectorRecord'],
    agent: ['AiConversation', 'AiAgentMemory', 'AiAgentRun', 'AiReviewRequest'],
  };

  const findings: AiFinding[] = [];

  for (const id of installed) {
    const missing = (REQUIRED[id] ?? []).filter(
      (model) => !new RegExp(`^model ${model} \\{`, 'm').test(schema),
    );

    if (missing.length === 0) continue;

    findings.push({
      area: `${id} schema`,
      status: 'FAIL',
      detail: `The framework schema copy is missing: ${missing.join(', ')}.`,
      remediation:
        'This application was generated before the AI platform. Re-run ' +
        '`node scripts/sync-schema-fragments.mjs` in the framework, copy ' +
        'prisma/schema/00-framework.prisma across, and run a migration.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      area: 'schema',
      status: 'PASS',
      detail: 'The framework schema copy has every AI table the installed modules need.',
    });
  }

  return findings;
}

async function checkModels(applicationRoot: string, installed: string[]): Promise<AiFinding[]> {
  if (!installed.includes('ai')) return [];

  const loaded = await loadJsonFrom(applicationRoot, LOCATIONS.models);

  if (!loaded) {
    return [
      {
        area: 'model catalog',
        status: 'WARN',
        detail:
          'No model catalog found. The framework ships none deliberately — prices change monthly ' +
          'and availability varies by account.',
        remediation: `Add one at ${LOCATIONS.models[0]}, or register models in code at start-up.`,
      },
    ];
  }

  const { registry, problems } = buildModelRegistry(loaded.contents);

  const findings: AiFinding[] = problems.map((problem) => ({
    area: 'model catalog',
    status: 'FAIL' as const,
    detail: problem,
  }));

  for (const problem of registry.validate()) {
    findings.push({
      area: 'model catalog',
      // A warning: stale pricing and a dangling supersession are both wrong and neither stops the
      // application from running.
      status: 'WARN',
      detail: problem,
    });
  }

  if (findings.length === 0) {
    findings.push({
      area: 'model catalog',
      status: 'PASS',
      detail: `${registry.list().length} model(s) in ${loaded.path}, all valid.`,
    });
  }

  return findings;
}

async function checkAgents(applicationRoot: string, installed: string[]): Promise<AiFinding[]> {
  if (!installed.includes('agent')) return [];

  const loaded = await loadJsonFrom(applicationRoot, LOCATIONS.agents);
  if (!loaded) {
    return [
      {
        area: 'agents',
        status: 'INFO',
        detail: 'No agent definitions found. The agent module is installed but declares nothing.',
        remediation: `Add definitions at ${LOCATIONS.agents[0]}, or register them in code.`,
      },
    ];
  }

  const { registry, problems } = buildAgentRegistry(loaded.contents);

  const findings: AiFinding[] = problems.map((problem) => ({
    area: 'agents',
    status: 'FAIL' as const,
    detail: problem,
  }));

  /*
   * An agent that requires review, in an application with no review queue.
   *
   * The worst failure in this file. The agent runs, produces output that is supposed to be
   * checked, and there is nothing to check it — so the control the definition asks for silently
   * does not exist.
   */
  const needsReview = registry.list().filter((agent) => agent.requiresReview);

  if (needsReview.length > 0) {
    const sources = await readCompositionRoots(applicationRoot);

    if (
      sources !== null &&
      !sources.includes('human-review') &&
      !sources.includes('ReviewService')
    ) {
      findings.push({
        area: 'human review',
        status: 'FAIL',
        detail:
          `${needsReview.map((agent) => agent.id).join(', ')} require human review, and no review ` +
          'service is wired. Their output would go out unchecked.',
        remediation: 'Wire ReviewService from @trustsystem/human-review. See docs/human-review.md.',
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      area: 'agents',
      status: 'PASS',
      detail: `${registry.list().length} agent(s) in ${loaded.path}, all valid.`,
    });
  }

  return findings;
}

/**
 * Whether a provider key has been committed.
 *
 * The one check here that is about a real incident rather than a misconfiguration. A key in a
 * checked-in file is a key that has to be rotated, and the sooner somebody knows the better.
 */
async function checkSecrets(applicationRoot: string, installed: string[]): Promise<AiFinding[]> {
  if (installed.length === 0) return [];

  const candidates = ['.env', '.env.local', 'ai/models.json', 'config/ai/models.json'];
  const findings: AiFinding[] = [];

  // Prefixes long enough to be specific. A short one matches prose.
  const KEY_PATTERNS = [
    { name: 'an OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
    { name: 'an Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'a Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/ },
    { name: 'an xAI key', pattern: /\bxai-[A-Za-z0-9_-]{20,}/ },
  ];

  for (const relative of candidates) {
    const path = join(applicationRoot, relative);
    if (!existsSync(path)) continue;

    const contents = await readFile(path, 'utf8');

    for (const { name, pattern } of KEY_PATTERNS) {
      if (!pattern.test(contents)) continue;

      findings.push({
        area: 'secrets',
        status: relative.startsWith('.env') ? 'WARN' : 'FAIL',
        // The file and the kind of key. Never the key, not even truncated — a doctor that prints
        // a prefix has copied the secret into a terminal, a scrollback and a screenshot.
        detail: `${relative} contains what looks like ${name}.`,
        remediation: relative.startsWith('.env')
          ? `Confirm ${relative} is in .gitignore, and never commit it.`
          : `Move the key out of ${relative} into the environment, and rotate it — this file is committed.`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      area: 'secrets',
      status: 'PASS',
      detail: 'No provider key found in a committed file.',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// ai list-models
// ---------------------------------------------------------------------------

export async function runAiListModels(options: AiCommandOptions, output: Output): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());
  if (!applicationRoot) return noApplication(output);

  const loaded = await loadJsonFrom(applicationRoot, LOCATIONS.models);

  if (!loaded) {
    if (options.json) {
      output.info(JSON.stringify({ models: [], source: null }, null, 2));
      return 0;
    }

    output.warn('No model catalog found.');
    output.blank();
    output.detail(`  Looked in: ${LOCATIONS.models.join(', ')}`);
    output.detail(
      '  The framework ships no models on purpose: prices change monthly and availability varies',
    );
    output.detail('  by account, so a shipped catalog would be wrong for everybody within weeks.');
    return 0;
  }

  const { registry, problems } = buildModelRegistry(loaded.contents);
  const models = registry.list();

  if (options.json) {
    output.info(JSON.stringify({ source: loaded.path, models, problems }, null, 2));
    return problems.length > 0 ? 1 : 0;
  }

  output.info(style.bold(`Models (${loaded.path})`));
  output.blank();

  if (models.length === 0) {
    output.detail('  None registered.');
  } else {
    output.info(
      formatRows(
        models.map((model): [string, string] => [
          `${isUsable(model) ? ' ' : '!'} ${model.id}`,
          describeModel(model, options.verbose === true),
        ]),
      ),
    );
  }

  if (problems.length > 0) {
    output.blank();
    output.error(`${problems.length} invalid entry(s):`);
    for (const problem of problems) output.detail(`  ${problem}`);
  }

  const warnings = registry.validate();
  if (warnings.length > 0) {
    output.blank();
    output.warn('Worth attention:');
    for (const warning of warnings) output.detail(`  ${warning}`);
  }

  return problems.length > 0 ? 1 : 0;
}

function describeModel(model: Model, verbose: boolean): string {
  const price = `${(model.pricing.inputCentsPerMillion / 100).toFixed(2)}/${(
    model.pricing.outputCentsPerMillion / 100
  ).toFixed(2)} per M`;

  const base = `${model.provider}  ${model.status}  ${model.contextTokens.toLocaleString()} ctx  ${price}`;

  if (!verbose) return base;

  const age = pricingAgeDays(model);

  return (
    `${base}\n    ${model.capabilities.join(', ') || 'no declared capabilities'}` +
    `\n    pricing verified ${age} day(s) ago` +
    (model.allowedOrganizationIds.length > 0
      ? `\n    restricted to ${model.allowedOrganizationIds.length} organization(s)`
      : '')
  );
}

// ---------------------------------------------------------------------------
// ai list-agents
// ---------------------------------------------------------------------------

export async function runAiListAgents(options: AiCommandOptions, output: Output): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());
  if (!applicationRoot) return noApplication(output);

  const loaded = await loadJsonFrom(applicationRoot, LOCATIONS.agents);

  if (!loaded) {
    if (options.json) {
      output.info(JSON.stringify({ agents: [], source: null }, null, 2));
      return 0;
    }

    output.warn('No agent definitions found.');
    output.blank();
    output.detail(`  Looked in: ${LOCATIONS.agents.join(', ')}`);
    output.detail(
      '  @trustsystem/agent-framework ships nine example definitions to copy from. They are examples,',
    );
    output.detail('  not defaults: nothing is registered until an application registers it.');
    return 0;
  }

  const { registry, problems } = buildAgentRegistry(loaded.contents);
  const described = registry.describe();

  if (options.json) {
    output.info(JSON.stringify({ source: loaded.path, agents: described, problems }, null, 2));
    return problems.length > 0 ? 1 : 0;
  }

  output.info(style.bold(`Agents (${loaded.path})`));
  output.blank();

  if (described.length === 0) {
    output.detail('  None registered.');
  } else {
    output.info(
      formatRows(
        described.map((agent): [string, string] => [
          `${agent.requiresReview ? 'R' : ' '} ${agent.id}`,
          `${agent.role}  ${agent.tools} tool(s)  ${agent.maxSteps} steps  prompt: ${agent.promptSource}`,
        ]),
      ),
    );

    if (described.some((agent) => agent.requiresReview)) {
      output.blank();
      output.detail('  R — every output must be reviewed by a person before it is used.');
    }
  }

  if (problems.length > 0) {
    output.blank();
    output.error(`${problems.length} invalid definition(s):`);
    for (const problem of problems) output.detail(`  ${problem}`);
  }

  return problems.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// ai validate-prompts
// ---------------------------------------------------------------------------

export interface PromptProblem {
  file: string;
  key: string;
  severity: 'error' | 'warning';
  message: string;
}

export async function runAiValidatePrompts(
  options: AiCommandOptions,
  output: Output,
): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());
  if (!applicationRoot) return noApplication(output);

  const directory = LOCATIONS.prompts
    .map((relative) => join(applicationRoot, relative))
    .find((path) => existsSync(path));

  if (!directory) {
    if (options.json) {
      output.info(JSON.stringify({ checked: 0, problems: [] }, null, 2));
      return 0;
    }

    output.warn('No prompt directory found.');
    output.blank();
    output.detail(`  Looked in: ${LOCATIONS.prompts.join(', ')}`);
    return 0;
  }

  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const problems: PromptProblem[] = [];
  let checked = 0;

  for (const file of files) {
    const contents = await readJson(join(directory, file));
    const entries = Array.isArray(contents) ? contents : [contents];

    for (const entry of entries) {
      checked += 1;
      problems.push(...validatePrompt(file, entry));
    }
  }

  const errors = problems.filter((problem) => problem.severity === 'error');

  if (options.json) {
    output.info(JSON.stringify({ directory, checked, problems }, null, 2));
    return errors.length > 0 ? 1 : 0;
  }

  output.info(style.bold(`Prompts (${directory})`));
  output.detail(`  ${checked} prompt version(s) in ${files.length} file(s)`);
  output.blank();

  if (problems.length === 0) {
    output.success('Every prompt is valid.');
    return 0;
  }

  for (const problem of problems) {
    const line = `  ${problem.file}  ${problem.key}: ${problem.message}`;
    if (problem.severity === 'error') output.error(line);
    else output.warn(line);
  }

  output.blank();
  output.detail(`  ${errors.length} error(s), ${problems.length - errors.length} warning(s)`);

  return errors.length > 0 ? 1 : 0;
}

/**
 * Checks one prompt version.
 *
 * Four things, in order of how expensive the mistake is:
 *
 *   1. It parses. A prompt that fails the schema never renders.
 *   2. The template's syntax is valid — an unbalanced `{{#if}}` reaches the model as literal
 *      text, which is a bug that produces a plausible answer.
 *   3. Every variable used is declared, and every variable declared is used. The first is a
 *      render-time failure; the second is usually a rename that only got done in one place.
 *   4. Anything that looks like user input is marked `untrusted`. That flag is what turns on
 *      injection scanning, and a variable that carries a support ticket without it is the gap.
 */
function validatePrompt(file: string, entry: unknown): PromptProblem[] {
  const key = (entry as { promptKey?: string } | null)?.promptKey ?? '(unnamed)';

  /*
   * Storage-owned fields are filled in before parsing.
   *
   * `id`, `createdAt` and `createdById` are assigned by the registry when a version is created —
   * a prompt file in version control is a definition, not a stored row, and requiring them here
   * would make every prompt file carry three fields nobody maintains. Everything that describes
   * the prompt itself is still validated.
   */
  const parsed = promptVersionSchema.safeParse({
    id: 'unsaved',
    createdAt: new Date(0),
    createdById: null,
    ...(entry as Record<string, unknown>),
  });

  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      file,
      key,
      severity: 'error' as const,
      message: `${issue.path.join('.') || '(root)'} — ${issue.message}`,
    }));
  }

  const version = parsed.data;
  const problems: PromptProblem[] = [];
  const templates = [version.template, ...(version.system ? [version.system] : [])];

  for (const template of templates) {
    for (const problem of validateTemplateSyntax(template)) {
      problems.push({ file, key, severity: 'error', message: problem });
    }
  }

  const declared = new Set(version.variables.map((variable) => variable.name));
  const used = new Set(templates.flatMap((template) => referencedVariables(template)));

  for (const name of used) {
    if (declared.has(name)) continue;
    problems.push({
      file,
      key,
      severity: 'error',
      message: `{{${name}}} is used but not declared, so rendering fails.`,
    });
  }

  for (const name of declared) {
    if (used.has(name)) continue;
    problems.push({
      file,
      key,
      severity: 'warning',
      message: `"${name}" is declared but never used. Usually a rename done in one place.`,
    });
  }

  const components = new Set(Object.keys(version.components));
  for (const template of templates) {
    for (const name of referencedComponents(template)) {
      if (components.has(name)) continue;
      problems.push({
        file,
        key,
        severity: 'error',
        message: `{{> ${name}}} refers to a component this prompt does not define.`,
      });
    }
  }

  // Names that almost always carry user input.
  const USER_INPUT = /(message|question|query|input|ticket|comment|body|text|content|feedback)/i;

  for (const variable of version.variables) {
    if (variable.untrusted || !USER_INPUT.test(variable.name)) continue;

    problems.push({
      file,
      key,
      severity: 'warning',
      message:
        `"${variable.name}" looks like user input but is not marked untrusted. Injection ` +
        'scanning and audit redaction both key off that flag.',
    });
  }

  if (version.status === 'published' && !version.contentHash) {
    problems.push({
      file,
      key,
      severity: 'error',
      message: 'A published version has no content hash, so tampering cannot be detected.',
    });
  }

  return problems;
}

// ---------------------------------------------------------------------------
// ai evaluate
// ---------------------------------------------------------------------------

export interface AiEvaluateOptions extends AiCommandOptions {
  /** A recorded run to compare against. */
  baseline?: string;
  /** The run to compare. Without it, the command validates suites only. */
  candidate?: string;
  tolerance?: string;
}

/**
 * `trustos ai evaluate`.
 *
 * Validates evaluation suites, and compares two recorded runs when given them.
 *
 * It does not call a model, and the reason is worth stating rather than hiding behind a missing
 * feature: doing so needs provider credentials, a gateway, a tenant and a policy — everything the
 * application has and the CLI deliberately does not. The application runs the evaluation and
 * writes the result; this compares results and fails a build on a regression.
 */
export async function runAiEvaluate(options: AiEvaluateOptions, output: Output): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());
  if (!applicationRoot) return noApplication(output);

  if (options.baseline && options.candidate) {
    return compareRuns(options, output);
  }

  const directory = LOCATIONS.evaluations
    .map((relative) => join(applicationRoot, relative))
    .find((path) => existsSync(path));

  if (!directory) {
    if (options.json) {
      output.info(JSON.stringify({ suites: [], problems: [] }, null, 2));
      return 0;
    }

    output.warn('No evaluation suites found.');
    output.blank();
    output.detail(`  Looked in: ${LOCATIONS.evaluations.join(', ')}`);
    output.detail('  A suite is a list of cases and the thresholds each must meet.');
    return 0;
  }

  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const suites: Array<{ file: string; id: string; cases: number }> = [];
  const problems: string[] = [];

  for (const file of files) {
    const contents = await readJson(join(directory, file));
    const parsed = evaluationSuiteSchema.safeParse(contents);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${file}: ${issue.path.join('.') || '(root)'} — ${issue.message}`);
      }
      continue;
    }

    suites.push({ file, id: parsed.data.id, cases: parsed.data.cases.length });

    /*
     * A suite with no thresholds measures and enforces nothing.
     *
     * It still produces numbers, which is what makes it worth flagging: a report full of scores
     * that can never fail reads exactly like one that passed.
     */
    const enforced = parsed.data.cases.some(
      (entry) =>
        Object.keys(entry.thresholds).length > 0 ||
        Object.keys(parsed.data.defaultThresholds).length > 0,
    );

    if (!enforced) {
      problems.push(
        `${file}: no case sets a threshold, so nothing in this suite can fail. It will report ` +
          'scores that always pass.',
      );
    }

    const noExpectations = parsed.data.cases.filter(
      (entry) => entry.expected.length === 0 && entry.forbidden.length === 0,
    );

    if (noExpectations.length === parsed.data.cases.length) {
      problems.push(
        `${file}: no case states what the answer must or must not contain, so only the generic ` +
          'heuristics apply.',
      );
    }
  }

  if (options.json) {
    output.info(JSON.stringify({ directory, suites, problems }, null, 2));
    return problems.length > 0 ? 1 : 0;
  }

  output.info(style.bold(`Evaluation suites (${directory})`));
  output.blank();

  if (suites.length > 0) {
    output.info(
      formatRows(
        suites.map((suite): [string, string] => [
          `  ${suite.id}`,
          `${suite.cases} case(s)  ${suite.file}`,
        ]),
      ),
    );
  }

  if (problems.length > 0) {
    output.blank();
    for (const problem of problems) output.warn(`  ${problem}`);
  }

  output.blank();
  output.detail(
    '  This validates suites. Running one needs a model, so it runs in the application:',
  );
  output.detail('  see EvaluationService.runAndCompare in docs/evaluation.md.');
  output.detail(
    '  To compare two recorded runs: trustos ai evaluate --baseline a.json --candidate b.json',
  );

  return problems.length > 0 ? 1 : 0;
}

async function compareRuns(options: AiEvaluateOptions, output: Output): Promise<number> {
  const baseline = await readJson(options.baseline!);
  const candidate = await readJson(options.candidate!);

  if (!baseline || !candidate) {
    output.error('Could not read both runs.');
    return 1;
  }

  const service = new EvaluationService();

  const comparison = service.compare(
    reviveRun(baseline),
    reviveRun(candidate),
    options.tolerance ? { tolerance: Number(options.tolerance) } : {},
  );

  if (options.json) {
    output.info(JSON.stringify(comparison, null, 2));
    return comparison.verdict === 'worse' ? 1 : 0;
  }

  output.info(style.bold(`Comparison: ${comparison.verdict}`));
  output.blank();

  if (comparison.newFailures.length > 0) {
    output.error(`  Newly failing: ${comparison.newFailures.join(', ')}`);
  }
  if (comparison.fixed.length > 0) {
    output.success(`  Now passing: ${comparison.fixed.join(', ')}`);
  }

  // Per case, not per average: an average that barely moved hides the two cases that fell off a
  // cliff behind three that improved slightly.
  for (const regression of comparison.regressions) {
    output.warn(
      `  ${regression.caseId}  ${regression.metric}  ${regression.from.toFixed(2)} → ${regression.to.toFixed(2)}`,
    );
  }

  if (comparison.regressions.length === 0 && comparison.newFailures.length === 0) {
    output.success('  No regression.');
  }

  return comparison.verdict === 'worse' ? 1 : 0;
}

/** Dates survive JSON as strings; `compare` needs them back. */
function reviveRun(raw: Record<string, unknown>): never {
  return {
    ...raw,
    startedAt: new Date(String(raw.startedAt ?? 0)),
    finishedAt: new Date(String(raw.finishedAt ?? 0)),
  } as never;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function buildModelRegistry(contents: unknown): { registry: ModelRegistry; problems: string[] } {
  const entries = Array.isArray(contents)
    ? contents
    : ((contents as { models?: unknown[] })?.models ?? []);

  const registry = new ModelRegistry();
  const problems: string[] = [];

  for (const entry of entries) {
    try {
      registry.register(entry);
    } catch (error) {
      problems.push(describeError(error));
    }
  }

  return { registry, problems };
}

function buildAgentRegistry(contents: unknown): { registry: AgentRegistry; problems: string[] } {
  const entries = Array.isArray(contents)
    ? contents
    : ((contents as { agents?: unknown[] })?.agents ?? []);

  const registry = new AgentRegistry();
  const problems: string[] = [];

  for (const entry of entries) {
    try {
      registry.register(entry);
    } catch (error) {
      problems.push(describeError(error));
    }
  }

  return { registry, problems };
}

/** The details, not just the summary — a summary alone says "not valid" and nothing else. */
function describeError(error: unknown): string {
  const details = (error as { details?: Array<{ path?: string; message: string }> }).details;

  if (details?.length) {
    return details.map((detail) => `${detail.path ?? ''} ${detail.message}`.trim()).join('; ');
  }

  return error instanceof Error ? error.message : String(error);
}

async function readCompositionRoots(applicationRoot: string): Promise<string | null> {
  const paths = [
    'apps/api/src/app.module.ts',
    'src/app.module.ts',
    'apps/worker/src/worker.module.ts',
  ]
    .map((relative) => join(applicationRoot, relative))
    .filter((path) => existsSync(path));

  if (paths.length === 0) return null;

  return (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');
}

async function loadJsonFrom(
  applicationRoot: string,
  candidates: string[],
): Promise<{ path: string; contents: unknown } | null> {
  for (const relative of candidates) {
    const path = join(applicationRoot, relative);
    if (!existsSync(path)) continue;

    const contents = await readJson(path);
    if (contents !== null) return { path: relative, contents };
  }

  return null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findApplicationRoot(from: string): string | null {
  let current = from;

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'trustos.json'))) return current;

    const parent = join(current, '..');
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function noApplication(output: Output): number {
  output.error('No trustos.json found in this directory or any parent.');
  output.blank();
  output.detail('  Run this inside a generated application, or pass --path <dir>.');
  return 1;
}

function printFindings(
  title: string,
  report: AiDoctorReport,
  output: Output,
  verbose: boolean,
): void {
  output.info(style.bold(title));
  output.detail(`  ${report.applicationRoot}`);
  output.blank();

  output.info(
    formatRows(
      report.findings.map((finding): [string, string] => [
        `${finding.status.padEnd(4)}  ${finding.area}`,
        finding.detail,
      ]),
    ),
  );

  const actionable = report.findings.filter((finding) => finding.remediation);

  if (actionable.length > 0) {
    output.blank();
    output.info(style.bold('What to do'));
    for (const finding of actionable) {
      output.detail(`  ${finding.area}: ${finding.remediation}`);
    }
  }

  if (verbose) {
    output.blank();
    output.info(style.bold('What this cannot see'));
    output.detail('  Whether a provider adapter actually authenticates — that needs a request.');
    output.detail('  Whether the model catalog matches what the provider currently offers.');
    output.detail('  Whether guardrail thresholds are right for this deployment.');
    output.detail('  Whether anybody is actually working the review queue.');
  }

  output.blank();
  output.info(
    report.ok ? style.bold('No blocking problems.') : style.bold('Blocking problems found.'),
  );
}
