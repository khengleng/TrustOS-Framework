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
      '@trustos/template-registry': pkg('template-registry'),
      '@trustos/generator-core': pkg('generator-core'),
      '@trustos/cli': pkg('cli'),
      '@trustos/validation': pkg('validation'),

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
    },
  },
});
