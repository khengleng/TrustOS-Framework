#!/usr/bin/env node
/**
 * Generates the eight integration module packages.
 *
 * These are thin: each one wraps a framework package from phase 6 in the module contract, so
 * `trustos add-module events` works the same way `trustos add-module search` does. The
 * implementation lives in the framework package; the module package contributes the
 * declarations — permissions, routes, audit events, health — and the lifecycle.
 *
 * Generated rather than hand-written because eight packages of the same shape, written by hand,
 * become eight packages of *slightly different* shape within a month. The per-module specifics
 * are the data below; everything else is identical by construction.
 *
 *   node scripts/scaffold-integration-modules.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What differs between the eight. Everything else is generated identically. */
const MODULES = [
  {
    id: 'events',
    className: 'EventsModule',
    pascal: 'Events',
    title: 'Event Bus',
    summary:
      'Typed, versioned domain events with a schema registry, ordering per aggregate, retry, dead letters and replay.',
    framework: ['@trustos/event-bus', '@trustos/event-registry', '@trustos/event-sdk'],
    healthDetail: 'The bus is running and the schema registry is populated.',
    note:
      'The registry is the load-bearing part: an event whose schema is not registered is never\n * published, so a renamed payload field fails at the publisher rather than at three consumers.',
  },
  {
    id: 'webhook',
    className: 'WebhookModule',
    pascal: 'Webhook',
    title: 'Webhooks',
    summary:
      'Outbound webhooks with HMAC signatures, overlapping secret rotation, replay protection and delivery history.',
    framework: ['@trustos/webhooks', '@trustos/webhook-runtime'],
    healthDetail: 'Endpoints are configured and deliveries are not backing up.',
    note:
      'Read `destination.ts` in `@trustos/webhook-runtime` before changing anything about where a\n * delivery goes. A webhook URL is attacker-controlled input the server then makes a request to.',
  },
  {
    id: 'jobs',
    className: 'JobsModule',
    pascal: 'Jobs',
    title: 'Background Jobs',
    summary:
      'A durable job queue in the database: leased execution, retry with backoff, priority, progress and history.',
    framework: ['@trustos/job-runtime'],
    healthDetail: 'The queue is being worked and nothing has been waiting too long.',
    note:
      'The lease is what keeps a job from running twice. A worker that loses its lease mid-run\n * discards its outcome rather than writing it — see the header of `worker.ts`.',
  },
  {
    id: 'scheduler',
    className: 'SchedulerModule',
    pascal: 'Scheduler',
    title: 'Scheduler',
    summary:
      'Cron, interval and one-time schedules with IANA timezone support and explicit daylight-saving handling.',
    framework: ['@trustos/scheduler'],
    healthDetail: 'The scheduler is ticking and no schedule is overdue.',
    note:
      'A schedule enqueues a job rather than running work itself, which is what makes a scheduled\n * task retryable, cancellable and recoverable after a crash.',
  },
  {
    id: 'adapter',
    className: 'AdapterModule',
    pascal: 'Adapter',
    title: 'Provider Adapters',
    summary:
      'The five-method provider contract with a registry, circuit-breaker-guarded calls and lifecycle management.',
    framework: ['@trustos/adapter-framework', '@trustos/provider-sdk'],
    healthDetail: 'Every registered provider is reachable.',
    note:
      'The framework ships no provider implementation. That is the phase 6 boundary: the seam is\n * the deliverable, and the adapter belongs to whatever product is built on this.',
  },
  {
    id: 'import',
    className: 'ImportModule',
    pascal: 'Import',
    title: 'Import',
    summary:
      'Bulk import with CSV and JSON parsing, per-row validation, preview, dry run, apply and rollback.',
    framework: ['@trustos/import'],
    healthDetail: 'The import handlers are registered.',
    note:
      'Validation runs over every row before anything is written. An import that wrote 4,000 rows\n * and then failed leaves a state nobody can describe afterwards.',
  },
  {
    id: 'export',
    className: 'ExportModule',
    pascal: 'Export',
    title: 'Export',
    summary:
      'Streaming export to CSV, JSON and NDJSON with keyset pagination and formula-injection escaping.',
    framework: ['@trustos/export'],
    healthDetail: 'The export sources are registered.',
    note:
      'Rows are never all in memory at once, and a cell beginning `=` is neutralised on the way\n * out — an export is the one file guaranteed to be opened in a spreadsheet.',
  },
  {
    id: 'sync',
    className: 'SyncModule',
    pascal: 'Sync',
    title: 'Synchronization',
    summary:
      'Pull, push and bidirectional synchronization with incremental watermarks and conflict policies.',
    framework: ['@trustos/sync'],
    healthDetail: 'No sync connection is paused or accumulating conflicts.',
    note:
      'The watermark is always the remote’s own value, and it advances only after a batch is\n * processed. Both rules are silent when broken — see the header of `sync.ts`.',
  },
];

const SHARED_DEPENDENCIES = [
  '@trustos/errors',
  '@trustos/logging',
  '@trustos/module-registry',
  '@trustos/module-sdk',
  '@trustos/observability',
  '@trustos/shared-types',
];

function packageJson(module) {
  const dependencies = {};
  for (const name of [...SHARED_DEPENDENCIES, ...module.framework].sort()) {
    dependencies[name] = '0.1.0';
  }

  return `${JSON.stringify(
    {
      name: `@trustos/module-${module.id}`,
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
  const references = [...SHARED_DEPENDENCIES, ...module.framework]
    .map((name) => ({ path: `../../${name.replace('@trustos/', '')}` }))
    .sort((a, b) => a.path.localeCompare(b.path));

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
import { moduleDeclarations } from '@trustos/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustos/module-sdk';

/**
 * The ${module.title.toLowerCase()} module.
 *
 * ${module.summary}
 *
 * A thin wrapper. The implementation is in ${module.framework
   .map((name) => `\`${name}\``)
   .join(', ')} — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * ${module.note}
 */

export const ${module.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}ConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ${module.pascal}Config = z.infer<typeof ${module.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}ConfigSchema>;

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
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
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
export const ${module.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Module = defineModule<${module.pascal}Config>({
  ...moduleDeclarations('${module.id}'),
  configSchema: ${module.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}ConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: create${module.pascal},
});
`;
}

function indexSource(module) {
  return `/**
 * @trustos/module-${module.id}
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
  const definitionName = `${module.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Module`;

  return `import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { ${definitionName} } from '../${module.id}.module';

/**
 * NestJS wiring for the ${module.title.toLowerCase()} module.
 *
 * Registers the lifecycle and the health indicator. The framework packages have their own Nest
 * modules for the services themselves — importing this one does not import those, so an
 * application chooses what it actually wires.
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
 * @trustos/module-${module.id}/nest
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
      '//': `Subpath stub: keeps NestJS bindings out of consumers that import '@trustos/module-${module.id}'.`,
      name: `@trustos/module-${module.id}-nest`,
      private: true,
      main: '../dist/nest/index.js',
      types: '../dist/nest/index.d.ts',
    },
    null,
    2,
  )}\n`;
}

function readme(module) {
  return `# @trustos/module-${module.id}

${module.summary}

## What this package is

A thin module wrapper. The implementation is in ${module.framework
    .map((name) => `\`${name}\``)
    .join(', ')}; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

\`\`\`bash
trustos add-module ${module.id}
\`\`\`

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

\`\`\`ts
import { ${module.className} } from '@trustos/module-${module.id}/nest';

@Module({ imports: [${module.className}.forRoot(binding)] })
export class AppModule {}
\`\`\`

## What it does not do

See \`outOfScope\` in the module catalog (\`trustos list-modules --verbose ${module.id}\`). The
short version: this phase ships the seam, not the integration.
`;
}

function agents(module) {
  return `# AGENTS.md — @trustos/module-${module.id}

${module.summary}

## Rules

1. **The implementation belongs in the framework package**, not here. This package declares and
   wires; ${module.framework.map((name) => `\`${name}\``).join(', ')} does the work. Logic added
   here is logic no other consumer of that package gets.
2. **Never widen a permission key.** Keys are permanent. Add one; never rename or repurpose.
3. **Always validate the tenant.** Every store call takes \`organizationId\` explicitly, and a
   method without one is a method that returns every tenant's rows.
4. **Always record an audit entry** for anything an operator does.
5. **Never log a secret**, including a signing secret, a token or a credential — not even
   truncated.
6. **Add a test for every behaviour**, including the negative one. A guarantee with no test that
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
