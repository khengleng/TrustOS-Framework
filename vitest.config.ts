import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `packages/${name}/src/index.ts`);
const mod = (name: string) => resolve(__dirname, `packages/modules/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      /*
       * Subpath aliases come first. Vite tries alias entries in order and matches
       * on prefix, so '@trustos/module-sdk' would otherwise capture
       * '@trustos/module-sdk/nest' and resolve it to the package root.
       */
      '@trustos/errors/nest': resolve(__dirname, 'packages/errors/src/nest/index.ts'),
      '@trustos/validation/nest': resolve(__dirname, 'packages/validation/src/nest/index.ts'),
      '@trustos/module-sdk/nest': resolve(__dirname, 'packages/module-sdk/src/nest/index.ts'),
      '@trustos/module-document/nest': resolve(
        __dirname,
        'packages/modules/document/src/nest/index.ts',
      ),
      '@trustos/module-feature-flags/nest': resolve(
        __dirname,
        'packages/modules/feature-flags/src/nest/index.ts',
      ),
      '@trustos/module-file-storage/nest': resolve(
        __dirname,
        'packages/modules/file-storage/src/nest/index.ts',
      ),
      '@trustos/module-notification/nest': resolve(
        __dirname,
        'packages/modules/notification/src/nest/index.ts',
      ),
      '@trustos/module-reporting/nest': resolve(
        __dirname,
        'packages/modules/reporting/src/nest/index.ts',
      ),
      '@trustos/module-search/nest': resolve(
        __dirname,
        'packages/modules/search/src/nest/index.ts',
      ),
      '@trustos/module-workflow/nest': resolve(
        __dirname,
        'packages/modules/workflow/src/nest/index.ts',
      ),

      '@trustos/identity/nest': resolve(__dirname, 'packages/identity/src/nest/index.ts'),
      '@trustos/authorization/nest': resolve(__dirname, 'packages/authorization/src/nest/index.ts'),
      '@trustos/api-keys/nest': resolve(__dirname, 'packages/api-keys/src/nest/index.ts'),
      '@trustos/session-security/nest': resolve(
        __dirname,
        'packages/session-security/src/nest/index.ts',
      ),
      '@trustos/service-accounts/nest': resolve(
        __dirname,
        'packages/service-accounts/src/nest/index.ts',
      ),

      '@trustos/api-keys': pkg('api-keys'),
      '@trustos/audit': pkg('audit'),
      '@trustos/authorization': pkg('authorization'),
      '@trustos/identity': pkg('identity'),
      '@trustos/auth': pkg('auth'),
      '@trustos/config': pkg('config'),
      '@trustos/database': pkg('database'),
      '@trustos/errors': pkg('errors'),
      '@trustos/logging': pkg('logging'),
      '@trustos/module-registry': pkg('module-registry'),
      '@trustos/module-sdk': pkg('module-sdk'),
      '@trustos/observability': pkg('observability'),
      '@trustos/rbac': pkg('rbac'),
      '@trustos/security-events': pkg('security-events'),
      '@trustos/security-policy': pkg('security-policy'),
      '@trustos/security-testing': pkg('security-testing'),
      '@trustos/service-accounts': pkg('service-accounts'),
      '@trustos/session-security': pkg('session-security'),
      '@trustos/shared-types': pkg('shared-types'),
      '@trustos/tenancy': pkg('tenancy'),
      '@trustos/workflow-core': pkg('workflow-core'),
      '@trustos/workflow-definition': pkg('workflow-definition'),
      '@trustos/workflow-policy': pkg('workflow-policy'),
      '@trustos/workflow-approvals': pkg('workflow-approvals'),
      '@trustos/workflow-tasks': pkg('workflow-tasks'),
      '@trustos/workflow-sla': pkg('workflow-sla'),
      '@trustos/workflow-escalation': pkg('workflow-escalation'),
      '@trustos/workflow-history': pkg('workflow-history'),
      '@trustos/workflow-runtime': pkg('workflow-runtime'),
      '@trustos/case-management': pkg('case-management'),
      '@trustos/retry': pkg('retry'),
      '@trustos/event-sdk': pkg('event-sdk'),
      '@trustos/event-registry': pkg('event-registry'),
      '@trustos/event-bus': pkg('event-bus'),
      '@trustos/webhooks': pkg('webhooks'),
      '@trustos/webhook-runtime': pkg('webhook-runtime'),
      '@trustos/job-runtime': pkg('job-runtime'),
      '@trustos/scheduler': pkg('scheduler'),
      '@trustos/provider-sdk': pkg('provider-sdk'),
      '@trustos/adapter-framework': pkg('adapter-framework'),
      '@trustos/sync': pkg('sync'),
      '@trustos/import': pkg('import'),
      '@trustos/export': pkg('export'),
      '@trustos/api-client-generator': pkg('api-client-generator'),
      '@trustos/integration-health': pkg('integration-health'),
      '@trustos/integration-monitor': pkg('integration-monitor'),

      // Phase 7 — the AI platform.
      '@trustos/ai-sdk': pkg('ai-sdk'),
      '@trustos/token-meter': pkg('token-meter'),
      '@trustos/model-registry': pkg('model-registry'),
      '@trustos/prompt-registry': pkg('prompt-registry'),
      '@trustos/prompt-security': pkg('prompt-security'),
      '@trustos/content-filter': pkg('content-filter'),
      '@trustos/guardrails': pkg('guardrails'),
      '@trustos/ai-policy': pkg('ai-policy'),
      '@trustos/cost-monitor': pkg('cost-monitor'),
      '@trustos/ai-cache': pkg('ai-cache'),
      '@trustos/model-router': pkg('model-router'),
      '@trustos/ai-gateway': pkg('ai-gateway'),
      '@trustos/embedding': pkg('embedding'),
      '@trustos/vector-store': pkg('vector-store'),
      '@trustos/knowledge': pkg('knowledge'),
      '@trustos/rag': pkg('rag'),
      '@trustos/function-calling': pkg('function-calling'),
      '@trustos/tool-execution': pkg('tool-execution'),
      '@trustos/agent-memory': pkg('agent-memory'),
      '@trustos/conversation': pkg('conversation'),
      '@trustos/agent-framework': pkg('agent-framework'),
      '@trustos/agent-runtime': pkg('agent-runtime'),
      '@trustos/human-review': pkg('human-review'),
      '@trustos/evaluation': pkg('evaluation'),
      '@trustos/ai-observability': pkg('ai-observability'),
      '@trustos/ai-workflows': pkg('ai-workflows'),

      // Phase 8 — the financial platform.
      '@trustos/financial-core': pkg('financial-core'),
      '@trustos/ledger': pkg('ledger'),
      '@trustos/accounts': pkg('accounts'),
      '@trustos/fx': pkg('fx'),
      '@trustos/fees': pkg('fees'),
      '@trustos/limits': pkg('limits'),
      '@trustos/financial-policy': pkg('financial-policy'),
      '@trustos/financial-events': pkg('financial-events'),
      '@trustos/financial-risk': pkg('financial-risk'),
      '@trustos/wallet': pkg('wallet'),
      '@trustos/transactions': pkg('transactions'),
      '@trustos/payments': pkg('payments'),
      '@trustos/settlement': pkg('settlement'),
      '@trustos/reconciliation': pkg('reconciliation'),
      '@trustos/financial-reporting': pkg('financial-reporting'),
      '@trustos/template-registry': pkg('template-registry'),
      '@trustos/generator-core': pkg('generator-core'),
      '@trustos/cli': pkg('cli'),
      '@trustos/validation': pkg('validation'),

      // Phase 11 — the financial product composition layer.
      '@trustos/financial-product-core': pkg('financial-product-core'),
      '@trustos/financial-block-registry': pkg('financial-block-registry'),
      '@trustos/connector-registry': pkg('connector-registry'),
      '@trustos/financial-product-rules': pkg('financial-product-rules'),
      '@trustos/financial-product-state-machine': pkg('financial-product-state-machine'),
      '@trustos/financial-product-variants': pkg('financial-product-variants'),
      '@trustos/financial-product-versioning': pkg('financial-product-versioning'),
      '@trustos/financial-product-policy': pkg('financial-product-policy'),
      '@trustos/financial-product-governance': pkg('financial-product-governance'),
      '@trustos/financial-product-composer': pkg('financial-product-composer'),
      '@trustos/financial-product-registry': pkg('financial-product-registry'),
      '@trustos/financial-product-runtime': pkg('financial-product-runtime'),
      '@trustos/financial-product-sandbox': pkg('financial-product-sandbox'),
      '@trustos/financial-product-simulator': pkg('financial-product-simulator'),
      '@trustos/financial-product-api': pkg('financial-product-api'),
      '@trustos/financial-product-observability': pkg('financial-product-observability'),

      /*
       * Subpath aliases, listed before their package so the more specific key
       * matches first: vite tries alias entries in order, and '@trustos/module-sdk'
       * would otherwise capture '@trustos/module-sdk/nest'.
       */

      // Modules. Aliased to source for the same reason the packages are: a test
      // must exercise the code in the working tree, not whatever was last built
      // into dist.
      '@trustos/module-document': mod('document'),
      '@trustos/module-feature-flags': mod('feature-flags'),
      '@trustos/module-file-storage': mod('file-storage'),
      '@trustos/module-notification': mod('notification'),
      '@trustos/module-reporting': mod('reporting'),
      '@trustos/module-search': mod('search'),
      '@trustos/module-workflow': mod('workflow'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.spec.ts', 'apps/**/*.spec.ts', 'templates/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      /**
       * Template *sources*, not tests of this repository.
       *
       * The specs under `templates/<id>/files/` are shipped into generated
       * applications and only resolve once the base and template layers have
       * been merged — `../../tokens` comes from the base layer. They are
       * exercised by generating an application and running its suite, which is
       * what the CI "generated applications" job does.
       *
       * `templates/saas-starter` is excluded from this rule: it is a real
       * workspace, not a generator template, and its tests do run here.
       */
      'templates/*/files/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'packages/modules/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.spec.ts', '**/nest/**'],

      /*
       * Report every file the include matches, not only the ones a test happened to load.
       *
       * Worth knowing, and measured rather than assumed: this does **not** fully close the gap.
       * The v8 provider still omits a file that no test and no importer ever loads, so a package
       * with neither is invisible in the table *and* absent from the headline total. The number
       * then answers "how well tested is the code we test", which trends toward 100% by
       * construction.
       *
       * So the total is a floor, not a measurement, and the only real fix is a spec file per
       * package. `trustos architecture-check` and the package-has-tests check in CI are what
       * actually catch the gap; this setting narrows it.
       */
      all: true,
    },
  },
});
