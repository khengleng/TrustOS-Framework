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
      '@trustos/validation': pkg('validation'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.spec.ts', 'apps/**/*.spec.ts', 'templates/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.spec.ts', '**/nest/**'],
    },
  },
});
