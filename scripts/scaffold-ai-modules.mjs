#!/usr/bin/env node
/**
 * Generates the three AI module packages: `ai`, `rag` and `agent`.
 *
 * Same shape and same reasoning as `scaffold-integration-modules.mjs`: each is a thin wrapper
 * that contributes the module contract — declarations, lifecycle, health — around framework
 * packages that do the work. Three packages of the same shape, hand-written, become three
 * packages of slightly different shape within a month.
 *
 *   node scripts/scaffold-ai-modules.mjs
 *
 * The split between the three is by what an application is trying to do, which is also what
 * `trustos add-module` asks:
 *
 *   ai     — call a model at all, safely: gateway, registry, prompts, guardrails, cost.
 *   rag    — answer from documents: embedding, vectors, chunking, retrieval, citations.
 *   agent  — let a model take actions: agent definitions, the tool loop, memory, review.
 *
 * `rag` and `agent` both depend on `ai`, because neither can work without a gateway, and an
 * application that installed one without the other would get a module that cannot make a request.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What differs between the three. Everything else is generated identically. */
const MODULES = [
  {
    id: 'ai',
    className: 'AiModule',
    pascal: 'Ai',
    title: 'AI Platform',
    summary:
      'The AI gateway and everything a model call has to pass through: model registry, prompt registry, guardrails, tenant policy, routing, cost accounting and caching.',
    framework: [
      '@trustsystem/ai-cache',
      '@trustsystem/ai-gateway',
      '@trustsystem/ai-observability',
      '@trustsystem/ai-policy',
      '@trustsystem/ai-sdk',
      '@trustsystem/content-filter',
      '@trustsystem/cost-monitor',
      '@trustsystem/guardrails',
      '@trustsystem/model-registry',
      '@trustsystem/model-router',
      '@trustsystem/prompt-registry',
      '@trustsystem/prompt-security',
      '@trustsystem/token-meter',
    ],
    healthDetail: 'The gateway is configured with at least one provider adapter and one model.',
    note:
      'Applications never call a provider directly. Everything goes through the gateway, because\n * the gateway is where policy, guardrails, cost and audit live — a request that bypasses it is a\n * request nobody can account for afterwards.',
  },
  {
    id: 'rag',
    className: 'RagModule',
    pascal: 'Rag',
    title: 'Retrieval-Augmented Generation',
    summary:
      'Answering from documents: chunking, embedding, a vector-store interface, hybrid search, citation checking and per-collection access control.',
    framework: [
      '@trustsystem/embedding',
      '@trustsystem/knowledge',
      '@trustsystem/rag',
      '@trustsystem/vector-store',
    ],
    healthDetail: 'The vector store is reachable and at least one collection is populated.',
    note:
      'The vector store is an interface with an in-memory default, and it is meant to be replaced.\n * Nothing above it knows which database is underneath, which is the only reason a deployment can\n * change that decision later.',
  },
  {
    id: 'agent',
    className: 'AgentModule',
    pascal: 'Agent',
    title: 'Agent Framework',
    summary:
      'Agents that take actions: declarative agent definitions, the tool loop with per-actor permission checks, memory, conversation state, stop conditions and human review.',
    framework: [
      '@trustsystem/agent-framework',
      '@trustsystem/agent-memory',
      '@trustsystem/agent-runtime',
      '@trustsystem/conversation',
      '@trustsystem/function-calling',
      '@trustsystem/human-review',
      '@trustsystem/tool-execution',
    ],
    healthDetail: 'The registered agents validate against the tools and prompts that exist.',
    note:
      'Every tool call is checked against the *actor’s* permissions, not the agent’s. That is what\n * makes a successful prompt injection survivable: an instruction smuggled into a support ticket\n * fails because the person the agent acts for cannot do the thing.',
  },
];

const SHARED_DEPENDENCIES = [
  '@trustsystem/errors',
  '@trustsystem/logging',
  '@trustsystem/module-registry',
  '@trustsystem/module-sdk',
  '@trustsystem/observability',
  '@trustsystem/shared-types',
];

/** `rag` and `agent` cannot work without the gateway. */
const MODULE_DEPENDENCIES = {
  ai: [],
  rag: ['@trustsystem/module-ai'],
  agent: ['@trustsystem/module-ai'],
};

const camel = (id) => id.replace(/-([a-z])/g, (_, character) => character.toUpperCase());

function packageJson(module) {
  const dependencies = {};
  for (const name of [
    ...SHARED_DEPENDENCIES,
    ...module.framework,
    ...MODULE_DEPENDENCIES[module.id],
  ].sort()) {
    dependencies[name] = '0.1.0';
  }

  return `${JSON.stringify(
    {
      name: `@trustsystem/module-${module.id}`,
      version: '0.1.0',
      private: true,
      description: `TrustOS ${module.title} module. ${module.summary}`,
      license: 'UNLICENSED',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      files: ['dist', 'nest', 'install', 'README.md', 'AGENTS.md'],
      scripts: { build: 'tsc -b', clean: 'tsc -b --clean' },
      dependencies,
      peerDependencies: { '@nestjs/common': '^11.0.0', '@nestjs/core': '^11.0.0' },
      peerDependenciesMeta: {
        '@nestjs/common': { optional: true },
        '@nestjs/core': { optional: true },
      },
      devDependencies: { '@nestjs/common': '^11.1.28', '@nestjs/core': '^11.1.28' },
    },
    null,
    2,
  )}\n`;
}

function tsconfig(module) {
  const references = [
    ...SHARED_DEPENDENCIES.map((name) => `../../${name.replace('@trustsystem/', '')}`),
    ...module.framework.map((name) => `../../${name.replace('@trustsystem/', '')}`),
    ...MODULE_DEPENDENCIES[module.id].map((name) => `../${name.replace('@trustsystem/module-', '')}`),
  ]
    .sort()
    .map((path) => ({ path }));

  return `${JSON.stringify(
    {
      extends: '../../../tsconfig.base.json',
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'dist', 'node_modules'],
      references,
    },
    null,
    2,
  )}\n`;
}

function moduleSource(module) {
  return `import { z } from 'zod';
import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';

/**
 * The ${module.title.toLowerCase()} module.
 *
 * ${module.summary}
 *
 * A thin wrapper. The implementation is in ${module.framework
   .map((name) => `\`${name}\``)
   .join(', ')} — this
 * package contributes the declarations the platform needs (permissions, audit events, health)
 * and the start/stop lifecycle.
 *
 * ${module.note}
 */

export const ${camel(module.id)}ConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ${module.pascal}Config = z.infer<typeof ${camel(module.id)}ConfigSchema>;

export interface ${module.pascal}Instance extends ModuleInstance {
  readonly ready: boolean;
}

export function create${module.pascal}(
  context: ModuleContext<${module.pascal}Config>,
): ${module.pascal}Instance {
  let ready = false;

  return {
    moduleId: '${module.id}',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: '${module.id}', enabled: ready },
        ready ? '${module.id} module initialized' : '${module.id} module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('${module.id}', async () =>
        ready
          ? { status: 'ok', detail: '${module.healthDetail}' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const ${camel(module.id)}Module = defineModule<${module.pascal}Config>({
  ...moduleDeclarations('${module.id}'),
  configSchema: ${camel(module.id)}ConfigSchema,
  // Every AI call is made on behalf of a tenant, and a request with no tenant cannot be policed,
  // budgeted or audited. There is no such thing as an untenanted AI module.
  tenantScoped: true,
  create: create${module.pascal},
});
`;
}

function indexSource(module) {
  return `/**
 * @trustsystem/module-${module.id}
 *
 * ${module.summary}
 *
 * The implementation lives in ${module.framework.map((name) => `\`${name}\``).join(', ')}; this
 * package is the module contract around it.
 */
export * from './${module.id}.module';
`;
}

function nestSource(module) {
  const definitionName = `${camel(module.id)}Module`;

  return `import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustsystem/module-sdk/nest';
import { ${definitionName} } from '../${module.id}.module';

/**
 * NestJS wiring for the ${module.title.toLowerCase()} module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes ports — a store, an adapter, a vector database —
 * that only the application knows.
 */
@Module({})
export class ${module.className} {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: ${module.className},
      providers: [...moduleProviders(${definitionName}, binding)],
      exports: [],
    };
  }
}
`;
}

function nestIndex(module) {
  return `/**
 * @trustsystem/module-${module.id}/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull \`@nestjs/common\` into
 * a worker or a test.
 */
export * from './${module.id}.nest-module';
`;
}

function nestStub(module) {
  return `${JSON.stringify(
    {
      '//': `Subpath stub: keeps NestJS bindings out of consumers that import '@trustsystem/module-${module.id}'.`,
      name: `@trustsystem/module-${module.id}-nest`,
      private: true,
      main: '../dist/nest/index.js',
      types: '../dist/nest/index.d.ts',
    },
    null,
    2,
  )}\n`;
}

function readme(module) {
  return `# @trustsystem/module-${module.id}

${module.summary}

## What this package is

A thin module wrapper. The implementation is in ${module.framework
    .map((name) => `\`${name}\``)
    .join(', ')}; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

\`\`\`bash
trustos add-module ${module.id}
\`\`\`

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

\`\`\`ts
import { ${module.className} } from '@trustsystem/module-${module.id}/nest';

@Module({ imports: [${module.className}.forRoot(binding)] })
export class AppModule {}
\`\`\`

The AI tables are part of the framework schema, so there is no migration to run.

## What it does not do

See \`outOfScope\` in the module catalog (\`trustos list-modules --verbose\`). The short version:
this is a platform, not a product. It ships no business-specific agent, no chat interface and no
provider credentials.
`;
}

function agents(module) {
  return `# AGENTS.md — @trustsystem/module-${module.id}

${module.summary}

## Rules

1. **The implementation belongs in the framework package**, not here. This package declares and
   wires; ${module.framework.map((name) => `\`${name}\``).join(', ')} does the work.
2. **Never bypass the gateway.** Every model call goes through \`@trustsystem/ai-gateway\`, which is
   where policy, guardrails, cost accounting and audit are applied.
3. **Never bypass guardrails**, and never add a flag that does. A caller who needs different
   thresholds configures a guardrail profile.
4. **Never expose secrets.** Provider credentials belong in the adapter's configuration and are
   redacted everywhere they are printed — never logged, not even truncated.
5. **Never bypass tenant isolation.** Every store call takes \`organizationId\` explicitly.
6. **Always audit AI actions**: every request, every tool call, every review decision.
7. **Always use the model registry and the prompt registry.** A hardcoded model name or an inline
   production prompt is a change nobody can review or roll back.
8. **Add a test for every behaviour**, including the negative one. A guarantee with no test that
   it holds is a comment.
`;
}

let written = 0;

for (const module of MODULES) {
  const base = join(root, 'packages/modules', module.id);

  const files = [
    ['package.json', packageJson(module)],
    ['tsconfig.json', tsconfig(module)],
    ['README.md', readme(module)],
    ['AGENTS.md', agents(module)],
    [`src/${module.id}.module.ts`, moduleSource(module)],
    ['src/index.ts', indexSource(module)],
    [`src/nest/${module.id}.nest-module.ts`, nestSource(module)],
    ['src/nest/index.ts', nestIndex(module)],
    ['nest/package.json', nestStub(module)],
  ];

  for (const [relative, contents] of files) {
    const target = join(base, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    written += 1;
  }

  console.log(`written    packages/modules/${module.id}  (${files.length} files)`);
}

console.log(`\n${written} file(s) across ${MODULES.length} module(s).`);
