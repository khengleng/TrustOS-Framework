import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@trustos/audit': pkg('audit'),
      '@trustos/auth': pkg('auth'),
      '@trustos/config': pkg('config'),
      '@trustos/database': pkg('database'),
      '@trustos/errors': pkg('errors'),
      '@trustos/logging': pkg('logging'),
      '@trustos/observability': pkg('observability'),
      '@trustos/rbac': pkg('rbac'),
      '@trustos/shared-types': pkg('shared-types'),
      '@trustos/tenancy': pkg('tenancy'),
      '@trustos/template-registry': pkg('template-registry'),
      '@trustos/generator-core': pkg('generator-core'),
      '@trustos/cli': pkg('cli'),
      '@trustos/validation': pkg('validation'),
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
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.spec.ts', '**/nest/**'],
    },
  },
});
