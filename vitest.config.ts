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

      '@trustos/audit': pkg('audit'),
      '@trustos/auth': pkg('auth'),
      '@trustos/config': pkg('config'),
      '@trustos/database': pkg('database'),
      '@trustos/errors': pkg('errors'),
      '@trustos/logging': pkg('logging'),
      '@trustos/module-registry': pkg('module-registry'),
      '@trustos/module-sdk': pkg('module-sdk'),
      '@trustos/observability': pkg('observability'),
      '@trustos/rbac': pkg('rbac'),
      '@trustos/shared-types': pkg('shared-types'),
      '@trustos/tenancy': pkg('tenancy'),
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
