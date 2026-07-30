import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { GeneratorError } from './errors';

/**
 * `trustos.json` — a generated application's provenance and module list.
 *
 * The installer reads it to answer three questions: is this a TrustOS
 * application, which framework version was it generated against, and which
 * modules are already installed. Without it, `trustos add-module` would be a
 * command that writes into whatever directory it happens to be run from.
 */

export const installedModuleSchema = z
  .object({
    id: z.string().min(1).max(60),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    installedAt: z.string().min(1).max(40),
    /** True when it was pulled in by another module rather than requested. */
    installedAsDependency: z.boolean().default(false),
  })
  .strict();

export type InstalledModule = z.infer<typeof installedModuleSchema>;

/**
 * Deliberately not `.strict()`.
 *
 * A newer CLI writing a field an older one does not know about must not make the
 * older one refuse to read the file. Unknown keys are preserved on write — see
 * `mergeApplicationManifest`.
 */
export const applicationManifestSchema = z.object({
  frameworkVersion: z.string().min(1).max(40),
  template: z.string().min(1).max(60),
  templateVersion: z.string().min(1).max(40),
  cliVersion: z.string().min(1).max(40),
  generatedAt: z.string().min(1).max(40),
  application: z.object({
    name: z.string().min(1).max(120),
    packageName: z.string().min(1).max(214),
    displayName: z.string().min(1).max(160),
    organization: z.string().min(1).max(160),
  }),
  generated: z.object({
    api: z.boolean(),
    admin: z.boolean(),
    auth: z.boolean(),
    deploymentTarget: z.string().min(1).max(40),
  }),
  modules: z.array(installedModuleSchema).default([]),
});

export type ApplicationManifest = z.infer<typeof applicationManifestSchema>;

export const MANIFEST_FILENAME = 'trustos.json';

export interface LoadedManifest {
  manifest: ApplicationManifest;
  /** The parsed file as it was on disk, so unknown keys survive a write. */
  raw: Record<string, unknown>;
  path: string;
}

/**
 * Locates the application root.
 *
 * Walks upward looking for `trustos.json`, so the command works from anywhere
 * inside a generated project — `apps/api`, `docs`, wherever the developer
 * happened to be.
 */
export function resolveApplicationRoot(startDirectory: string): string {
  let current = resolve(startDirectory);

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, MANIFEST_FILENAME))) return current;

    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }

  throw new GeneratorError(
    'invalid_input',
    `No ${MANIFEST_FILENAME} found in ${resolve(startDirectory)} or any parent directory.`,
    'Run this from inside a generated TrustOS application, or pass --path.',
  );
}

export async function loadApplicationManifest(applicationRoot: string): Promise<LoadedManifest> {
  const path = join(applicationRoot, MANIFEST_FILENAME);

  if (!existsSync(path)) {
    throw new GeneratorError(
      'invalid_input',
      `${path} does not exist.`,
      'Run this from inside a generated TrustOS application, or pass --path.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new GeneratorError(
      'invalid_input',
      `${MANIFEST_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = applicationManifestSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    throw new GeneratorError(
      'invalid_input',
      `${MANIFEST_FILENAME} is not a valid TrustOS application manifest: ${problems}`,
      'The file may be from a different tool, or hand-edited.',
    );
  }

  return { manifest: result.data, raw: raw as Record<string, unknown>, path };
}

/**
 * Serializes the manifest with the module list replaced.
 *
 * Unknown top-level keys are preserved: an application may carry fields a future
 * CLI added, and rewriting the file should not be a way to lose them.
 */
export function mergeApplicationManifest(
  loaded: LoadedManifest,
  modules: InstalledModule[],
): string {
  const merged = {
    ...loaded.raw,
    modules: [...modules].sort((left, right) => (left.id < right.id ? -1 : 1)),
  };

  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** Ids of the modules already installed. */
export function installedModuleIds(manifest: ApplicationManifest): string[] {
  return manifest.modules.map((module) => module.id);
}
