import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATES, resolveTemplateChain } from './registry';

/**
 * Drift.
 *
 * `templates/`, `industry.ts` and `docs/industry-reference.md` are all generated from
 * `scripts/template-specs.mjs`. Three artefacts derived from one source stay consistent only if
 * something notices when one of them was not regenerated — and the failure is silent otherwise:
 * `trustos templates` keeps advertising an entity nobody generates, and somebody picks the
 * template because of it.
 *
 * These tests are that something. They check the *relationships* rather than re-deriving the
 * files, because a test that regenerated the output and diffed it would pass by construction if
 * the generator itself were wrong.
 */

const repositoryRoot = join(__dirname, '..', '..', '..');
const templatesRoot = join(repositoryRoot, 'templates');

/** The layer directory a template's own files live in. */
const layerRoot = (id: string) => join(templatesRoot, id, 'files');

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name).slice(templatesRoot.length + 1)],
  );
}

describe('registry and template trees agree', () => {
  it('every registered template has a directory', () => {
    for (const template of TEMPLATES) {
      expect({ id: template.id, exists: existsSync(layerRoot(template.id)) }).toEqual({
        id: template.id,
        exists: true,
      });
    }
  });

  it('every template directory is registered', () => {
    /*
     * The direction that catches a deleted registry entry. A directory nobody can name is dead
     * weight; worse, `resolveTemplateChain` would fail on a child that still points at it.
     */
    const directories = readdirSync(templatesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '_base')
      .map((entry) => entry.name)
      // Left over from an earlier phase: a reference application, not a template layer.
      .filter((name) => name !== 'saas-starter');

    const registered = new Set(TEMPLATES.map((template) => template.id));

    expect(directories.filter((name) => !registered.has(name))).toEqual([]);
  });

  it('every entity a manifest advertises has a model in the chain', () => {
    /*
     * The drift that matters most. A developer chooses a template from its entity list; a list
     * naming a model nobody generates is how they choose the wrong one.
     */
    for (const template of TEMPLATES) {
      const schema = resolveTemplateChain(template.id)
        .flatMap((entry) => walk(layerRoot(entry.id)))
        .filter((file) => file.endsWith('.prisma'))
        .map((file) => readFileSync(join(templatesRoot, file), 'utf8'))
        .join('\n');

      // Templates predating the generated catalog describe their entities in prose; only assert
      // on the ones whose models are generated.
      if (schema.length === 0) continue;

      const missing = template.entities.filter(
        (entity) => !new RegExp(`^model ${entity} \\{`, 'm').test(schema),
      );

      expect({ id: template.id, missing }).toEqual({ id: template.id, missing: [] });
    }
  });

  it('every child ships the aggregators its chain needs', () => {
    /*
     * The three overridden files are the whole inheritance mechanism. A child missing one
     * generates a project that silently drops its parent's screens, permissions or controllers —
     * and it compiles.
     */
    for (const template of TEMPLATES) {
      if (!template.extends) continue;

      const files = walk(layerRoot(template.id));

      for (const aggregator of [
        'packages/product-domain/src/index.ts',
        'apps/api/src/modules/product/product.module.ts',
      ]) {
        expect({
          id: template.id,
          aggregator,
          present: files.some((file) => file.endsWith(aggregator)),
        }).toEqual({ id: template.id, aggregator, present: true });
      }
    }
  });

  it('a child’s aggregators name every layer in its chain', () => {
    for (const template of TEMPLATES) {
      if (!template.extends) continue;

      const module = readFileSync(
        join(layerRoot(template.id), 'apps/api/src/modules/product/product.module.ts'),
        'utf8',
      );

      const chain = resolveTemplateChain(template.id).map((entry) => entry.id);
      const missing = chain.filter((id) => !module.includes(`./${id}/${id}.module`));

      expect({ id: template.id, missing }).toEqual({ id: template.id, missing: [] });
    }
  });

  it('the industry reference covers every template', () => {
    const reference = readFileSync(join(repositoryRoot, 'docs/industry-reference.md'), 'utf8');

    const missing = TEMPLATES.filter(
      (template) => template.category !== 'foundation' && !reference.includes(`\`${template.id}\``),
    ).map((template) => template.id);

    expect(missing).toEqual([]);
  });

  it('every manifest points at documentation that exists', () => {
    for (const template of TEMPLATES) {
      expect({
        id: template.id,
        documentation: template.documentation,
        exists: existsSync(join(repositoryRoot, template.documentation)),
      }).toEqual({ id: template.id, documentation: template.documentation, exists: true });
    }
  });
});
