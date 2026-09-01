import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFrameworkDependencies,
  generateApplication,
  planApplication,
  prepareGeneration,
  type GenerationRequest,
} from './generate';
import { planFingerprint } from './plan';
import type { GeneratorError } from './errors';

/**
 * End-to-end generation tests against the real templates.
 *
 * These run the same code path `trustos new` does, into a temporary directory,
 * so a change that breaks generation fails here rather than in CI's much slower
 * install-and-build job.
 */

const TEMPLATES_ROOT = join(__dirname, '..', '..', '..', 'templates');
const CLI_VERSION = '0.1.0';
const FIXED_TIMESTAMP = '2026-07-29T00:00:00.000Z';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'trustos-generate-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    templateId: 'generic-saas',
    applicationName: 'demo-app',
    packageName: 'demo-app',
    organizationName: 'TrustOS',
    productDisplayName: 'Demo App',
    description: 'A generated application.',
    targetDirectory: workspace,
    generatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

const options = {
  templatesRoot: TEMPLATES_ROOT,
  cliVersion: CLI_VERSION,
  frameworkVersion: '0.1.0',
};

describe('prepareGeneration', () => {
  it('rejects a template the registry does not know', async () => {
    await expect(
      prepareGeneration(request({ templateId: 'not-a-template' }), options),
    ).rejects.toThrow(/Unknown template/);
  });

  it('refuses a framework older than the template requires', async () => {
    await expect(
      prepareGeneration(request(), { ...options, frameworkVersion: '0.0.1' }),
    ).rejects.toThrow(/needs framework 0\.1\.0 or newer/);
  });

  it('refuses a deployment target the template does not support', async () => {
    await expect(
      prepareGeneration(request({ deploymentTarget: 'railway' }), options),
    ).resolves.toBeDefined();

    const generic = await prepareGeneration(request({ deploymentTarget: 'local' }), options);
    expect(generic.values.isRailway).toBe(false);
  });

  it('contains the project inside the target directory', async () => {
    const context = await prepareGeneration(request(), options);
    expect(context.projectRoot).toBe(join(workspace, 'demo-app'));
  });

  it('rejects an application name that would escape the target directory', async () => {
    await expect(
      prepareGeneration(request({ applicationName: '../evil' }), options),
    ).rejects.toThrow();
  });

  it('refuses to generate nothing', async () => {
    await expect(
      prepareGeneration(request({ includeApi: false, includeAdmin: false }), options),
    ).rejects.toThrow(/at least one application/);
  });
});

describe('planApplication', () => {
  it('produces a plan with the files a generated application needs', async () => {
    const plan = await planApplication(request(), options);
    const paths = plan.files.map((file) => file.path);

    for (const required of [
      'package.json',
      'README.md',
      'AGENTS.md',
      'trustos.json',
      '.gitignore',
      '.env.example',
      'vitest.config.ts',
      'railway.toml',
      'docs/architecture.md',
      'docs/deployment.md',
      'docs/security.md',
      'prisma/schema/00-framework.prisma',
      'prisma/schema/10-product.prisma',
      'prisma/seed.ts',
      'apps/api/src/main.ts',
      'apps/api/src/app.module.ts',
      'apps/admin/src/app/layout.tsx',
    ]) {
      expect(paths, `missing ${required}`).toContain(required);
    }
  });

  it('never plans a .env file', async () => {
    const plan = await planApplication(request(), options);
    const paths = plan.files.map((file) => file.path);

    expect(paths).not.toContain('.env');
    expect(paths.filter((path) => path.startsWith('.env'))).toEqual(['.env.example']);
  });

  it('plans no key material', async () => {
    const plan = await planApplication(request(), options);
    for (const file of plan.files) {
      expect(file.path).not.toMatch(/\.(pem|key|p12|pfx|jks)$/);
    }
  });

  it('omits the admin app when it is not requested', async () => {
    const plan = await planApplication(request({ includeAdmin: false }), options);
    const paths = plan.files.map((file) => file.path);

    expect(paths.some((path) => path.startsWith('apps/admin/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('apps/api/'))).toBe(true);
  });

  it('omits railway.toml for a local-only deployment', async () => {
    const plan = await planApplication(request({ deploymentTarget: 'local' }), options);
    expect(plan.files.map((file) => file.path)).not.toContain('railway.toml');
  });

  it('lets a template override a base file, recording the override', async () => {
    // Every template ships its own product-domain index, overriding the base.
    const plan = await planApplication(request(), options);
    const overridden = plan.overrides.map((entry) => entry.path);

    expect(overridden).toContain('packages/shared-types/src/index.ts');
    for (const entry of plan.overrides) {
      expect(entry.winner).toBe('generic-saas');
      expect(entry.loser).toBe('_base');
    }
  });

  it('normalizes every file to LF with a trailing newline', async () => {
    const plan = await planApplication(request(), options);
    for (const file of plan.files) {
      expect(file.contents, file.path).not.toContain('\r');
      if (file.contents.length > 0) expect(file.contents.endsWith('\n'), file.path).toBe(true);
    }
  });

  it.each(['generic-saas', 'merchant', 'learning', 'payment-gateway', 'telegram-mini-app'])(
    'plans %s without an unresolved placeholder',
    async (templateId) => {
      const plan = await planApplication(request({ templateId }), options);

      for (const file of plan.files) {
        // Handlebars strict mode would already have thrown on an undeclared
        // variable; this catches a literal that survived a mis-typed escape.
        //
        // Railway's own `${{VAR}}` syntax is deliberate literal output, so it
        // is removed before the sweep rather than being allowed to pass.
        const withoutPlatformSyntax = file.contents.replace(/\$\{\{[A-Za-z0-9_.]+\}\}/g, '');
        expect(withoutPlatformSyntax, file.path).not.toMatch(/\{\{[a-zA-Z#/]/);
      }
    },
  );
});

describe('determinism', () => {
  it('produces byte-identical output for identical inputs', async () => {
    const first = await planApplication(request(), options);
    const second = await planApplication(request(), options);

    expect(planFingerprint(second)).toBe(planFingerprint(first));
  });

  it('orders files deterministically', async () => {
    const plan = await planApplication(request(), options);
    const paths = plan.files.map((file) => file.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it('changes output when an input changes, so determinism is not staleness', async () => {
    const first = await planApplication(request(), options);
    const second = await planApplication(request({ productDisplayName: 'Other Name' }), options);

    expect(planFingerprint(second)).not.toBe(planFingerprint(first));
  });

  it('treats the timestamp as an input rather than ambient state', async () => {
    // This is what lets "same inputs, same output" hold while trustos.json
    // still records when a project was generated.
    const a = await planApplication(request({ generatedAt: FIXED_TIMESTAMP }), options);
    const b = await planApplication(request({ generatedAt: '2030-01-01T00:00:00.000Z' }), options);

    expect(planFingerprint(a)).not.toBe(planFingerprint(b));
  });
});

describe('generateApplication', () => {
  it('writes the plan to disk', async () => {
    const result = await generateApplication(request(), options);

    expect(result.created.length).toBeGreaterThan(40);
    expect(existsSync(join(result.projectRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(result.projectRoot, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(result.projectRoot, '.env'))).toBe(false);
  });

  it('records provenance in trustos.json', async () => {
    const result = await generateApplication(request(), options);
    const manifest = JSON.parse(
      await readFile(join(result.projectRoot, 'trustos.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      frameworkVersion: '0.1.0',
      template: 'generic-saas',
      templateVersion: '0.1.0',
      cliVersion: CLI_VERSION,
      generatedAt: FIXED_TIMESTAMP,
    });
  });

  it('generates for the local identity provider by default', async () => {
    const result = await generateApplication(request(), options);
    const example = await readFile(join(result.projectRoot, '.env.example'), 'utf8');

    // The default has to boot on the first attempt. `oidc` needs an issuer that
    // exists, so it is opt-in.
    expect(example).toContain('IDENTITY_PROVIDER=local');
    // The OIDC values are present but commented, so switching modes is uncommenting
    // rather than remembering which four variables exist.
    expect(example).toContain('# OIDC_ISSUER_URL=');

    const manifest = JSON.parse(
      await readFile(join(result.projectRoot, 'trustos.json'), 'utf8'),
    ) as { generated: { identityProvider: string } };
    expect(manifest.generated.identityProvider).toBe('local');
  });

  it('generates for an OIDC issuer when asked', async () => {
    const result = await generateApplication(request({ identityProvider: 'oidc' }), options);
    const example = await readFile(join(result.projectRoot, '.env.example'), 'utf8');

    expect(example).toContain('IDENTITY_PROVIDER=oidc');
    // Uncommented, because in this mode they are required rather than optional.
    expect(example).toMatch(/^OIDC_ISSUER_URL=/m);
    expect(example).toMatch(/^OIDC_CLIENT_ID=/m);
    // Present and empty. A generated file must never contain a credential, even a
    // fake-looking one, because a fake-looking one gets committed and then replaced
    // in place by a real one.
    expect(example).toMatch(/^OIDC_CLIENT_SECRET=$/m);

    const manifest = JSON.parse(
      await readFile(join(result.projectRoot, 'trustos.json'), 'utf8'),
    ) as { generated: { identityProvider: string } };
    expect(manifest.generated.identityProvider).toBe('oidc');
  });

  it('substitutes the product identity everywhere it belongs', async () => {
    const result = await generateApplication(
      request({ productDisplayName: 'PayKH Gateway', packageName: '@wing/paykh' }),
      options,
    );

    const packageJson = await readFile(join(result.projectRoot, 'package.json'), 'utf8');
    expect(packageJson).toContain('"@wing/paykh"');

    const readme = await readFile(join(result.projectRoot, 'README.md'), 'utf8');
    expect(readme).toContain('PayKH Gateway');

    const agents = await readFile(join(result.projectRoot, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('PayKH Gateway');
  });

  it('writes an .env.example with placeholder secrets, never real ones', async () => {
    const result = await generateApplication(request(), options);
    const example = await readFile(join(result.projectRoot, '.env.example'), 'utf8');

    expect(example).toContain('JWT_SECRET=');
    // The value must be an obvious placeholder the config package rejects in
    // production, not something that looks usable.
    expect(example).toMatch(/JWT_SECRET=development-only/);
    expect(example).toContain('Never commit');
  });

  it('refuses a non-empty target directory without --force', async () => {
    await mkdir(join(workspace, 'demo-app'), { recursive: true });
    await writeFile(join(workspace, 'demo-app', 'existing.txt'), 'keep me');

    await expect(generateApplication(request(), options)).rejects.toThrow(/not empty/);
    // The pre-existing file is untouched.
    expect(await readFile(join(workspace, 'demo-app', 'existing.txt'), 'utf8')).toBe('keep me');
  });

  it('overwrites with --force', async () => {
    await generateApplication(request(), options);
    const result = await generateApplication(request(), { ...options, force: true });

    expect(result.overwritten.length).toBeGreaterThan(0);
  });

  it('writes nothing in dry-run mode', async () => {
    const result = await generateApplication(request(), { ...options, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.created.length).toBeGreaterThan(40);
    expect(existsSync(join(workspace, 'demo-app'))).toBe(false);
  });

  it('reports every file through the onFile hook', async () => {
    const seen: string[] = [];
    const result = await generateApplication(request(), {
      ...options,
      onFile: (event) => void seen.push(`${event.action}:${event.path}`),
    });

    expect(seen).toHaveLength(result.created.length + result.overwritten.length);
    expect(seen.every((entry) => entry.startsWith('created:'))).toBe(true);
  });
});

describe('buildFrameworkDependencies', () => {
  it('uses a version range by default', () => {
    const deps = buildFrameworkDependencies('0.1.0');
    expect(deps['@trustsystem/config']).toBe('^0.1.0');
    expect(Object.keys(deps)).toContain('@trustsystem/tenancy');
  });

  it('links to a local checkout when a framework path is given', () => {
    const deps = buildFrameworkDependencies('0.1.0', '/opt/trustos');
    expect(deps['@trustsystem/config']).toBe('file:/opt/trustos/packages/config');
  });

  it('covers every package a generated application imports', () => {
    const deps = Object.keys(buildFrameworkDependencies('0.1.0'));
    for (const name of [
      'config',
      'database',
      'errors',
      'logging',
      'validation',
      'observability',
      'auth',
      'rbac',
      'tenancy',
      'audit',
      'shared-types',
    ]) {
      expect(deps).toContain(`@trustsystem/${name}`);
    }
  });
});

describe('error codes', () => {
  it('reports target_not_empty so the CLI can suggest --force', async () => {
    await mkdir(join(workspace, 'demo-app'), { recursive: true });
    await writeFile(join(workspace, 'demo-app', 'existing.txt'), 'x');

    try {
      await generateApplication(request(), options);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GeneratorError).code).toBe('target_not_empty');
      expect((error as GeneratorError).hint).toContain('--force');
    }
  });
});
