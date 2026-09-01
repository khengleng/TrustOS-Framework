import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `packages/${name}/src/index.ts`);
const mod = (name: string) => resolve(__dirname, `packages/modules/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      /*
       * Subpath aliases come first. Vite tries alias entries in order and matches
       * on prefix, so '@trustsystem/module-sdk' would otherwise capture
       * '@trustsystem/module-sdk/nest' and resolve it to the package root.
       */
      '@trustsystem/errors/nest': resolve(__dirname, 'packages/errors/src/nest/index.ts'),
      '@trustsystem/validation/nest': resolve(__dirname, 'packages/validation/src/nest/index.ts'),
      '@trustsystem/module-sdk/nest': resolve(__dirname, 'packages/module-sdk/src/nest/index.ts'),
      '@trustsystem/module-document/nest': resolve(
        __dirname,
        'packages/modules/document/src/nest/index.ts',
      ),
      '@trustsystem/module-feature-flags/nest': resolve(
        __dirname,
        'packages/modules/feature-flags/src/nest/index.ts',
      ),
      '@trustsystem/module-file-storage/nest': resolve(
        __dirname,
        'packages/modules/file-storage/src/nest/index.ts',
      ),
      '@trustsystem/module-notification/nest': resolve(
        __dirname,
        'packages/modules/notification/src/nest/index.ts',
      ),
      '@trustsystem/module-reporting/nest': resolve(
        __dirname,
        'packages/modules/reporting/src/nest/index.ts',
      ),
      '@trustsystem/module-search/nest': resolve(
        __dirname,
        'packages/modules/search/src/nest/index.ts',
      ),
      '@trustsystem/module-workflow/nest': resolve(
        __dirname,
        'packages/modules/workflow/src/nest/index.ts',
      ),

      '@trustsystem/identity/nest': resolve(__dirname, 'packages/identity/src/nest/index.ts'),
      '@trustsystem/authorization/nest': resolve(
        __dirname,
        'packages/authorization/src/nest/index.ts',
      ),
      '@trustsystem/api-keys/nest': resolve(__dirname, 'packages/api-keys/src/nest/index.ts'),
      '@trustsystem/session-security/nest': resolve(
        __dirname,
        'packages/session-security/src/nest/index.ts',
      ),
      '@trustsystem/service-accounts/nest': resolve(
        __dirname,
        'packages/service-accounts/src/nest/index.ts',
      ),

      '@trustsystem/api-keys': pkg('api-keys'),
      '@trustsystem/approval-workbench': pkg('approval-workbench'),
      '@trustsystem/audit': pkg('audit'),
      '@trustsystem/authorization': pkg('authorization'),
      '@trustsystem/identity': pkg('identity'),
      '@trustsystem/auth': pkg('auth'),
      '@trustsystem/config': pkg('config'),
      '@trustsystem/database': pkg('database'),
      '@trustsystem/errors': pkg('errors'),
      '@trustsystem/logging': pkg('logging'),
      '@trustsystem/module-registry': pkg('module-registry'),
      '@trustsystem/module-sdk': pkg('module-sdk'),
      '@trustsystem/observability': pkg('observability'),
      '@trustsystem/rbac': pkg('rbac'),
      '@trustsystem/security-events': pkg('security-events'),
      '@trustsystem/security-policy': pkg('security-policy'),
      '@trustsystem/security-testing': pkg('security-testing'),
      '@trustsystem/service-accounts': pkg('service-accounts'),
      '@trustsystem/session-security': pkg('session-security'),
      '@trustsystem/shared-types': pkg('shared-types'),
      '@trustsystem/tenancy': pkg('tenancy'),
      '@trustsystem/access-resolver': pkg('access-resolver'),
      '@trustsystem/workflow-core': pkg('workflow-core'),
      '@trustsystem/workflow-definition': pkg('workflow-definition'),
      '@trustsystem/workflow-policy': pkg('workflow-policy'),
      '@trustsystem/workflow-approvals': pkg('workflow-approvals'),
      '@trustsystem/workflow-tasks': pkg('workflow-tasks'),
      '@trustsystem/workflow-sla': pkg('workflow-sla'),
      '@trustsystem/workflow-escalation': pkg('workflow-escalation'),
      '@trustsystem/workflow-history': pkg('workflow-history'),
      '@trustsystem/workflow-runtime': pkg('workflow-runtime'),
      '@trustsystem/case-management': pkg('case-management'),
      '@trustsystem/retry': pkg('retry'),
      '@trustsystem/event-sdk': pkg('event-sdk'),
      '@trustsystem/event-registry': pkg('event-registry'),
      '@trustsystem/event-bus': pkg('event-bus'),
      '@trustsystem/webhooks': pkg('webhooks'),
      '@trustsystem/webhook-runtime': pkg('webhook-runtime'),
      '@trustsystem/job-runtime': pkg('job-runtime'),
      '@trustsystem/scheduler': pkg('scheduler'),
      '@trustsystem/provider-sdk': pkg('provider-sdk'),
      '@trustsystem/adapter-framework': pkg('adapter-framework'),
      '@trustsystem/sync': pkg('sync'),
      '@trustsystem/import': pkg('import'),
      '@trustsystem/export': pkg('export'),
      '@trustsystem/api-client-generator': pkg('api-client-generator'),
      '@trustsystem/integration-health': pkg('integration-health'),
      '@trustsystem/integration-monitor': pkg('integration-monitor'),

      // Phase 7 — the AI platform.
      '@trustsystem/ai-sdk': pkg('ai-sdk'),
      '@trustsystem/token-meter': pkg('token-meter'),
      '@trustsystem/model-registry': pkg('model-registry'),
      '@trustsystem/prompt-registry': pkg('prompt-registry'),
      '@trustsystem/prompt-security': pkg('prompt-security'),
      '@trustsystem/content-filter': pkg('content-filter'),
      '@trustsystem/guardrails': pkg('guardrails'),
      '@trustsystem/ai-policy': pkg('ai-policy'),
      '@trustsystem/cost-monitor': pkg('cost-monitor'),
      '@trustsystem/ai-cache': pkg('ai-cache'),
      '@trustsystem/model-router': pkg('model-router'),
      '@trustsystem/ai-gateway': pkg('ai-gateway'),
      '@trustsystem/embedding': pkg('embedding'),
      '@trustsystem/vector-store': pkg('vector-store'),
      '@trustsystem/knowledge': pkg('knowledge'),
      '@trustsystem/rag': pkg('rag'),
      '@trustsystem/function-calling': pkg('function-calling'),
      '@trustsystem/tool-execution': pkg('tool-execution'),
      '@trustsystem/agent-memory': pkg('agent-memory'),
      '@trustsystem/conversation': pkg('conversation'),
      '@trustsystem/agent-framework': pkg('agent-framework'),
      '@trustsystem/agent-runtime': pkg('agent-runtime'),
      '@trustsystem/human-review': pkg('human-review'),
      '@trustsystem/evaluation': pkg('evaluation'),
      '@trustsystem/ai-observability': pkg('ai-observability'),
      '@trustsystem/ai-workflows': pkg('ai-workflows'),

      // Phase 8 — the financial platform.
      '@trustsystem/financial-core': pkg('financial-core'),
      '@trustsystem/ledger': pkg('ledger'),
      '@trustsystem/accounts': pkg('accounts'),
      '@trustsystem/fx': pkg('fx'),
      '@trustsystem/fees': pkg('fees'),
      '@trustsystem/limits': pkg('limits'),
      '@trustsystem/financial-policy': pkg('financial-policy'),
      '@trustsystem/financial-events': pkg('financial-events'),
      '@trustsystem/financial-risk': pkg('financial-risk'),
      '@trustsystem/wallet': pkg('wallet'),
      '@trustsystem/transactions': pkg('transactions'),
      '@trustsystem/payments': pkg('payments'),
      '@trustsystem/settlement': pkg('settlement'),
      '@trustsystem/reconciliation': pkg('reconciliation'),
      '@trustsystem/financial-reporting': pkg('financial-reporting'),
      '@trustsystem/template-registry': pkg('template-registry'),
      '@trustsystem/generator-core': pkg('generator-core'),
      '@trustsystem/cli': pkg('cli'),
      '@trustsystem/validation': pkg('validation'),

      // Phase 11 — the financial product composition layer.
      '@trustsystem/financial-product-core': pkg('financial-product-core'),
      '@trustsystem/financial-block-registry': pkg('financial-block-registry'),
      '@trustsystem/connector-registry': pkg('connector-registry'),
      '@trustsystem/financial-product-rules': pkg('financial-product-rules'),
      '@trustsystem/financial-product-state-machine': pkg('financial-product-state-machine'),
      '@trustsystem/financial-product-variants': pkg('financial-product-variants'),
      '@trustsystem/financial-product-versioning': pkg('financial-product-versioning'),
      '@trustsystem/financial-product-policy': pkg('financial-product-policy'),
      '@trustsystem/financial-product-governance': pkg('financial-product-governance'),
      '@trustsystem/financial-product-composer': pkg('financial-product-composer'),
      '@trustsystem/financial-product-registry': pkg('financial-product-registry'),
      '@trustsystem/financial-product-runtime': pkg('financial-product-runtime'),
      '@trustsystem/financial-product-sandbox': pkg('financial-product-sandbox'),
      '@trustsystem/financial-product-simulator': pkg('financial-product-simulator'),
      '@trustsystem/financial-product-api': pkg('financial-product-api'),
      '@trustsystem/financial-product-observability': pkg('financial-product-observability'),

      // Phase 12 — the Governance Tool.
      '@trustsystem/governance-tool-core': pkg('governance-tool-core'),
      '@trustsystem/governance-auth-context': pkg('governance-auth-context'),
      '@trustsystem/governance-resource-policy': pkg('governance-resource-policy'),
      '@trustsystem/governance-data-access': pkg('governance-data-access'),
      '@trustsystem/governance-pii-policy': pkg('governance-pii-policy'),
      '@trustsystem/governance-export-control': pkg('governance-export-control'),
      '@trustsystem/governance-audit-bridge': pkg('governance-audit-bridge'),
      '@trustsystem/governance-workflow-bridge': pkg('governance-workflow-bridge'),
      '@trustsystem/governance-ai-bridge': pkg('governance-ai-bridge'),
      '@trustsystem/governance-environment-config': pkg('governance-environment-config'),
      '@trustsystem/governance-tool-runtime': pkg('governance-tool-runtime'),
      '@trustsystem/governance-tool-sdk': pkg('governance-tool-sdk'),
      '@trustsystem/governance-tool-integration': pkg('governance-tool-integration'),

      // Phase 13 — enterprise hardening.
      '@trustsystem/data-classification': pkg('data-classification'),
      '@trustsystem/data-catalog': pkg('data-catalog'),
      '@trustsystem/data-lineage': pkg('data-lineage'),
      '@trustsystem/data-retention': pkg('data-retention'),
      '@trustsystem/data-masking': pkg('data-masking'),
      '@trustsystem/data-access-policy': pkg('data-access-policy'),
      '@trustsystem/data-governance': pkg('data-governance'),
      '@trustsystem/policy-registry': pkg('policy-registry'),
      '@trustsystem/policy-evaluator': pkg('policy-evaluator'),
      '@trustsystem/policy-decision-log': pkg('policy-decision-log'),
      '@trustsystem/policy-engine': pkg('policy-engine'),
      '@trustsystem/sre-core': pkg('sre-core'),
      '@trustsystem/sli': pkg('sli'),
      '@trustsystem/slo': pkg('slo'),
      '@trustsystem/dependency-health': pkg('dependency-health'),
      '@trustsystem/incident-management': pkg('incident-management'),
      '@trustsystem/resilience': pkg('resilience'),
      '@trustsystem/api-catalog': pkg('api-catalog'),
      '@trustsystem/api-versioning': pkg('api-versioning'),
      '@trustsystem/api-consumer': pkg('api-consumer'),
      '@trustsystem/api-quota': pkg('api-quota'),
      '@trustsystem/api-rate-limit': pkg('api-rate-limit'),
      '@trustsystem/api-policy': pkg('api-policy'),
      '@trustsystem/developer-access': pkg('developer-access'),
      '@trustsystem/api-management': pkg('api-management'),
      '@trustsystem/backup': pkg('backup'),
      '@trustsystem/recovery': pkg('recovery'),
      '@trustsystem/disaster-recovery': pkg('disaster-recovery'),
      '@trustsystem/continuity': pkg('continuity'),
      '@trustsystem/resilience-testing': pkg('resilience-testing'),

      /*
       * Subpath aliases, listed before their package so the more specific key
       * matches first: vite tries alias entries in order, and '@trustsystem/module-sdk'
       * would otherwise capture '@trustsystem/module-sdk/nest'.
       */

      // Modules. Aliased to source for the same reason the packages are: a test
      // must exercise the code in the working tree, not whatever was last built
      // into dist.
      '@trustsystem/module-document': mod('document'),
      '@trustsystem/module-feature-flags': mod('feature-flags'),
      '@trustsystem/module-file-storage': mod('file-storage'),
      '@trustsystem/module-notification': mod('notification'),
      '@trustsystem/module-reporting': mod('reporting'),
      '@trustsystem/module-search': mod('search'),
      '@trustsystem/module-workflow': mod('workflow'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/*.spec.ts',
      'apps/**/*.spec.ts',
      'templates/**/*.spec.ts',
      // The validator is tested too. Its bugs are the expensive kind — they say "PASS".
      'scripts/**/*.spec.mjs',
    ],
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
