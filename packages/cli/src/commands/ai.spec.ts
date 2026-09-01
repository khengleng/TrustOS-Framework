import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCapturingOutput } from '../output';
import {
  runAiDoctor,
  runAiEvaluate,
  runAiListAgents,
  runAiListModels,
  runAiValidatePrompts,
} from './ai';

/**
 * These run against a real directory tree rather than a mocked filesystem.
 *
 * The commands exist to answer questions about a checkout, so a test that never touches one is
 * testing the wrong thing — every bug this code has had was about a path that did not exist, a
 * file that did not parse, or a heuristic that matched prose.
 */

let root: string;

function write(relative: string, contents: string | object): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

/** A generated application with the AI modules installed and wired. */
function application(options: { modules?: string[]; wired?: boolean } = {}): void {
  const modules = options.modules ?? ['ai'];

  write('trustos.json', { name: 'test-app' });
  write('package.json', {
    name: 'test-app',
    dependencies: Object.fromEntries(modules.map((id) => [`@trustsystem/module-${id}`, '0.1.0'])),
  });

  const imports =
    options.wired === false
      ? ''
      : modules
          .map(
            (id) =>
              `import { ${id[0]!.toUpperCase()}${id.slice(1)}Module } from '@trustsystem/module-${id}/nest';`,
          )
          .join('\n');

  write('apps/api/src/app.module.ts', `${imports}\n@Module({})\nexport class AppModule {}\n`);

  // The framework schema copy, with the AI tables the modules need.
  const models = [
    'AiModel',
    'AiPrompt',
    'AiPromptVersion',
    'AiPolicy',
    'AiRequestLog',
    'AiCacheEntry',
    'AiKnowledgeCollection',
    'AiKnowledgeDocument',
    'AiVectorRecord',
    'AiConversation',
    'AiAgentMemory',
    'AiAgentRun',
    'AiReviewRequest',
  ];

  write(
    'prisma/schema/00-framework.prisma',
    models.map((model) => `model ${model} {\n  id String @id\n}`).join('\n\n'),
  );
}

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'openai.gpt-4o',
  provider: 'openai',
  providerModelId: 'gpt-4o',
  displayName: 'GPT-4o',
  contextTokens: 128_000,
  maxOutputTokens: 4096,
  capabilities: ['tools'],
  pricing: {
    inputCentsPerMillion: 250,
    outputCentsPerMillion: 1000,
    verifiedAt: new Date().toISOString(),
  },
  ...overrides,
});

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: 'support-agent',
  name: 'Support Agent',
  role: 'Customer Support',
  description: 'Answers customer questions.',
  systemPrompt: 'You are a support agent.',
  stopConditions: ['final_answer', 'limit_reached'],
  ...overrides,
});

const prompt = (overrides: Record<string, unknown> = {}) => ({
  id: 'pv_1',
  promptKey: 'support.system',
  version: 1,
  organizationId: null,
  description: 'The support agent system prompt.',
  owner: 'Support',
  template: 'Answer {{question}} using only the sources.',
  variables: [
    {
      name: 'question',
      type: 'string',
      description: "The customer's question.",
      untrusted: true,
    },
  ],
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trustos-ai-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ai doctor', () => {
  it('refuses to guess when there is no application', async () => {
    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: undefined, json: false }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/No trustos\.json/);
  });

  it('passes on a wired application', async () => {
    application({ modules: ['ai'] });
    write('ai/models.json', [model()]);

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(0);
  });

  it('fails when a module is installed but never imported', async () => {
    // The commonest failure by a distance: the dependency is added, the import is not, and the
    // module does nothing at all — no error, no log line.
    application({ modules: ['ai'], wired: false });

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/installed but never imported/);
  });

  it('fails when rag is installed without ai', async () => {
    application({ modules: ['rag'] });

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/rag needs ai/);
  });

  it('fails when the schema copy predates the AI tables', async () => {
    application({ modules: ['ai'] });
    write('prisma/schema/00-framework.prisma', 'model User {\n  id String @id\n}');

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/missing: AiModel/);
  });

  it('warns when no provider adapter is registered', async () => {
    // The framework ships none, so a gateway with no adapter fails every request at the last step
    // — after policy, guardrails and routing have all passed.
    application({ modules: ['ai'] });

    const output = createCapturingOutput();
    await runAiDoctor({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(/No provider adapter registration found/);
  });

  it('fails when an agent requires review and nothing reviews', async () => {
    /*
     * The worst failure this command can find. The agent runs, produces output that is supposed
     * to be checked by a person, and there is nothing to check it — so the control the definition
     * asks for silently does not exist.
     */
    application({ modules: ['ai', 'agent'] });
    write('ai/agents.json', [agent({ requiresReview: true })]);

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/require human review, and no review service is wired/);
  });

  it('does not complain about review when the service is wired', async () => {
    application({ modules: ['ai', 'agent'] });
    write('ai/agents.json', [agent({ requiresReview: true })]);
    write(
      'apps/api/src/app.module.ts',
      "import { AiModule } from '@trustsystem/module-ai/nest';\n" +
        "import { AgentModule } from '@trustsystem/module-agent/nest';\n" +
        "import { ReviewService } from '@trustsystem/human-review';\n",
    );

    const output = createCapturingOutput();
    await runAiDoctor({ path: root }, output);

    expect(output.lines.join('\n')).not.toMatch(/no review service is wired/);
  });

  it('reports a provider key in a committed file as a failure', async () => {
    application({ modules: ['ai'] });
    write('ai/models.json', [{ ...model(), apiKey: `sk-ant-${'a'.repeat(40)}` }]);

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(1);

    const text = output.lines.join('\n');
    expect(text).toMatch(/contains what looks like an Anthropic key/);
    // Never the key itself. A doctor that prints a prefix has copied the secret into a terminal,
    // a scrollback and a screenshot.
    expect(text).not.toMatch(/aaaaaaaa/);
  });

  it('treats a key in .env as a warning, not a failure', async () => {
    // `.env` is not committed. The advice there is to confirm that, not to rotate.
    application({ modules: ['ai'] });
    write('ai/models.json', [model()]);
    write('.env', `OPENAI_API_KEY=sk-${'b'.repeat(40)}\n`);

    const output = createCapturingOutput();

    expect(await runAiDoctor({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/Confirm \.env is in \.gitignore/);
  });

  it('does not mistake a Nest providers array for a provider adapter', async () => {
    // The bug this replaced: every generated application has `providers: [` in its composition
    // root, so the check passed on every application that had no adapter at all.
    application({ modules: ['ai'] });
    write(
      'apps/api/src/app.module.ts',
      "import { AiModule } from '@trustsystem/module-ai/nest';\n" +
        '@Module({ providers: [SomethingElse] })\nexport class AppModule {}\n',
    );

    const output = createCapturingOutput();
    await runAiDoctor({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(/No provider adapter registration found/);
  });

  it('recognises a registered adapter', async () => {
    application({ modules: ['ai'] });
    write(
      'apps/api/src/app.module.ts',
      "import { AiModule } from '@trustsystem/module-ai/nest';\n" +
        'const gateway = new AiGateway({ adapters: [new OpenAiAdapter(config)] });\n',
    );

    const output = createCapturingOutput();
    await runAiDoctor({ path: root }, output);

    expect(output.lines.join('\n')).not.toMatch(/No provider adapter registration found/);
  });

  it('says what it cannot see when asked', async () => {
    application({ modules: ['ai'] });

    const output = createCapturingOutput();
    await runAiDoctor({ path: root, verbose: true }, output);

    expect(output.lines.join('\n')).toMatch(/Whether a provider adapter actually authenticates/);
  });

  it('produces machine-readable output', async () => {
    application({ modules: ['ai'] });
    write('ai/models.json', [model()]);

    const output = createCapturingOutput();
    await runAiDoctor({ path: root, json: true }, output);

    const report = JSON.parse(output.lines.join('\n')) as { installed: string[]; ok: boolean };
    expect(report.installed).toEqual(['ai']);
    expect(report.ok).toBe(true);
  });
});

describe('ai list-models', () => {
  it('explains why the framework ships none', async () => {
    application();

    const output = createCapturingOutput();

    expect(await runAiListModels({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/prices change monthly/);
  });

  it('lists what is registered', async () => {
    application();
    write('ai/models.json', [model(), model({ id: 'anthropic.sonnet', provider: 'anthropic' })]);

    const output = createCapturingOutput();

    expect(await runAiListModels({ path: root }, output)).toBe(0);

    const text = output.lines.join('\n');
    expect(text).toMatch(/openai\.gpt-4o/);
    expect(text).toMatch(/anthropic\.sonnet/);
  });

  it('names the field when an entry is invalid', async () => {
    application();
    write('ai/models.json', [{ ...model(), contextTokens: 'lots' }]);

    const output = createCapturingOutput();

    expect(await runAiListModels({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/contextTokens/);
  });

  it('warns about pricing nobody has verified in six months', async () => {
    // Cost reports computed from it are confidently wrong, which is worse than missing.
    application();
    write('ai/models.json', [
      model({
        pricing: {
          inputCentsPerMillion: 250,
          outputCentsPerMillion: 1000,
          verifiedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        },
      }),
    ]);

    const output = createCapturingOutput();
    await runAiListModels({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(/pricing last verified \d+ days ago/);
  });

  it('accepts a wrapped object as well as a bare array', async () => {
    application();
    write('ai/models.json', { models: [model()] });

    const output = createCapturingOutput();
    await runAiListModels({ path: root, json: true }, output);

    expect((JSON.parse(output.lines.join('\n')) as { models: unknown[] }).models).toHaveLength(1);
  });
});

describe('ai list-agents', () => {
  it('points at the examples when there are none', async () => {
    application();

    const output = createCapturingOutput();

    expect(await runAiListAgents({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/nine example definitions/);
  });

  it('marks the agents whose output must be reviewed', async () => {
    application();
    write('ai/agents.json', [
      agent(),
      agent({ id: 'security-reviewer', requiresReview: true, name: 'Security Reviewer' }),
    ]);

    const output = createCapturingOutput();
    await runAiListAgents({ path: root }, output);

    const text = output.lines.join('\n');
    expect(text).toMatch(/R security-reviewer/);
    expect(text).toMatch(/every output must be reviewed/);
  });

  it('reports an invalid definition with the reason', async () => {
    application();
    write('ai/agents.json', [agent({ stopConditions: ['final_answer'] })]);

    const output = createCapturingOutput();

    expect(await runAiListAgents({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/limit_reached must be/);
  });
});

describe('ai validate-prompts', () => {
  it('passes a valid prompt', async () => {
    application();
    write('ai/prompts/support.json', prompt());

    const output = createCapturingOutput();

    expect(await runAiValidatePrompts({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/Every prompt is valid/);
  });

  it('catches an unbalanced section', async () => {
    // Which otherwise reaches the model as literal text and produces a plausible answer.
    application();
    write('ai/prompts/support.json', prompt({ template: '{{#if question}}Answer {{question}}' }));

    const output = createCapturingOutput();

    expect(await runAiValidatePrompts({ path: root }, output)).toBe(1);
  });

  it('catches a variable used but not declared', async () => {
    application();
    write('ai/prompts/support.json', prompt({ template: 'Answer {{question}} for {{customer}}.' }));

    const output = createCapturingOutput();

    expect(await runAiValidatePrompts({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/\{\{customer\}\} is used but not declared/);
  });

  it('warns about a variable declared but never used', async () => {
    // Usually a rename done in one place. A warning, because it renders fine.
    application();
    write(
      'ai/prompts/support.json',
      prompt({
        variables: [
          { name: 'question', type: 'string', description: 'x', untrusted: true },
          { name: 'tone', type: 'string', description: 'y' },
        ],
      }),
    );

    const output = createCapturingOutput();

    expect(await runAiValidatePrompts({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/"tone" is declared but never used/);
  });

  it('warns when something that looks like user input is not marked untrusted', async () => {
    /*
     * That flag is what turns on injection scanning and audit redaction. A variable carrying a
     * support ticket without it is the gap, and nothing about the prompt looks wrong.
     */
    application();
    write(
      'ai/prompts/support.json',
      prompt({
        template: 'Answer {{customer_message}}.',
        variables: [{ name: 'customer_message', type: 'string', description: 'x' }],
      }),
    );

    const output = createCapturingOutput();
    await runAiValidatePrompts({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(/looks like user input but is not marked untrusted/);
  });

  it('catches a component that is referenced but not defined', async () => {
    application();
    write('ai/prompts/support.json', prompt({ template: '{{> preamble}} Answer {{question}}.' }));

    const output = createCapturingOutput();

    expect(await runAiValidatePrompts({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/does not define/);
  });

  it('checks every prompt in a file that holds several', async () => {
    application();
    write('ai/prompts/all.json', [prompt(), prompt({ promptKey: 'other.system', id: 'pv_2' })]);

    const output = createCapturingOutput();
    await runAiValidatePrompts({ path: root, json: true }, output);

    expect((JSON.parse(output.lines.join('\n')) as { checked: number }).checked).toBe(2);
  });
});

describe('ai evaluate', () => {
  const suite = (overrides: Record<string, unknown> = {}) => ({
    id: 'support-answers',
    name: 'Support answers',
    subject: 'support-agent',
    cases: [
      {
        id: 'refund-window',
        input: 'How long do I have to request a refund?',
        expected: ['30 days'],
        thresholds: { relevance: 0.4 },
        note: 'The commonest question.',
      },
    ],
    ...overrides,
  });

  it('validates a suite', async () => {
    application();
    write('ai/evaluations/support.json', suite());

    const output = createCapturingOutput();

    expect(await runAiEvaluate({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/support-answers/);
  });

  it('says plainly that it does not call a model', async () => {
    // Because that needs credentials, a gateway, a tenant and a policy — everything the
    // application has and the CLI deliberately does not.
    application();
    write('ai/evaluations/support.json', suite());

    const output = createCapturingOutput();
    await runAiEvaluate({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(/Running one needs a model/);
  });

  it('warns about a suite where nothing can fail', async () => {
    application();
    write(
      'ai/evaluations/support.json',
      suite({
        cases: [{ id: 'a', input: 'q', note: 'n' }],
      }),
    );

    const output = createCapturingOutput();

    expect(await runAiEvaluate({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/nothing in this suite can fail/);
  });

  it('compares two recorded runs and fails on a regression', async () => {
    application();

    const run = (score: number, passed: boolean) => ({
      id: 'run',
      suiteId: 'support-answers',
      subject: 'support-agent',
      organizationId: null,
      variant: 'v',
      startedAt: '2026-03-01T09:00:00.000Z',
      finishedAt: '2026-03-01T09:01:00.000Z',
      results: [
        {
          caseId: 'refund-window',
          output: 'x',
          metrics: [
            { name: 'relevance', kind: 'heuristic', score, raw: null, passed: null, detail: '' },
          ],
          passed,
          failures: [],
          latencyMs: 10,
          costCents: 0,
          error: null,
        },
      ],
      scores: { relevance: score },
      passed: passed ? 1 : 0,
      failed: passed ? 0 : 1,
      errored: 0,
      totalCostCents: 0,
    });

    write('baseline.json', run(0.9, true));
    write('candidate.json', run(0.3, false));

    const output = createCapturingOutput();

    const exit = await runAiEvaluate(
      {
        path: root,
        baseline: join(root, 'baseline.json'),
        candidate: join(root, 'candidate.json'),
      },
      output,
    );

    expect(exit).toBe(1);

    const text = output.lines.join('\n');
    expect(text).toMatch(/worse/);
    // Named per case, not as a shifted average.
    expect(text).toMatch(/refund-window/);
  });

  it('passes when two runs are the same', async () => {
    application();

    const run = {
      id: 'run',
      suiteId: 'support-answers',
      subject: 'support-agent',
      organizationId: null,
      variant: 'v',
      startedAt: '2026-03-01T09:00:00.000Z',
      finishedAt: '2026-03-01T09:01:00.000Z',
      results: [
        {
          caseId: 'a',
          output: 'x',
          metrics: [
            {
              name: 'relevance',
              kind: 'heuristic',
              score: 0.8,
              raw: null,
              passed: null,
              detail: '',
            },
          ],
          passed: true,
          failures: [],
          latencyMs: 10,
          costCents: 0,
          error: null,
        },
      ],
      scores: { relevance: 0.8 },
      passed: 1,
      failed: 0,
      errored: 0,
      totalCostCents: 0,
    };

    write('a.json', run);
    write('b.json', run);

    const output = createCapturingOutput();

    expect(
      await runAiEvaluate(
        { path: root, baseline: join(root, 'a.json'), candidate: join(root, 'b.json') },
        output,
      ),
    ).toBe(0);
    expect(output.lines.join('\n')).toMatch(/No regression/);
  });
});
