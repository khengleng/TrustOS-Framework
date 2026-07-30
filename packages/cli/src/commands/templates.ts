import {
  TEMPLATE_CATEGORIES,
  listTemplates,
  resolveTemplateChain,
  templateChildren,
  type TemplateCategory,
  type TemplateManifest,
} from '@trustos/template-registry';
import type { Output } from '../output';
import { formatRows, style } from '../output';

/**
 * `trustos templates` — the catalog, grouped.
 *
 * `list-templates` prints a flat list, which was the right shape for six templates and is the
 * wrong one for thirty: a developer scanning it cannot tell that `clinic` and `hospital` are the
 * same family, or that `marketplace` already contains everything `ecommerce` has. Grouping by
 * category and showing the inheritance is the difference between a catalog somebody reads and one
 * they scroll past.
 *
 * `list-templates` is kept, unchanged, because scripts call it.
 */

export interface TemplatesOptions {
  json?: boolean;
  verbose?: boolean;
  category?: string;
  /** Include deprecated templates. Off by default — see below. */
  all?: boolean;
}

const CATEGORY_TITLES: Record<TemplateCategory, string> = {
  foundation: 'Foundation',
  commerce: 'Commerce',
  'financial-services': 'Financial services',
  'business-operations': 'Business operations',
  education: 'Education',
  health: 'Health',
  'public-sector': 'Public and social',
  messaging: 'Messaging mini apps',
  portal: 'Portals',
};

const STATUS_BADGE: Record<TemplateManifest['status'], string> = {
  stable: '',
  experimental: 'experimental',
  deprecated: 'deprecated',
};

export function runTemplates(options: TemplatesOptions, output: Output): number {
  const all = listTemplates();

  if (options.category && !TEMPLATE_CATEGORIES.includes(options.category as TemplateCategory)) {
    output.error(
      `Unknown category "${options.category}". Categories: ${TEMPLATE_CATEGORIES.join(', ')}.`,
    );
    return 1;
  }

  /*
   * Deprecated templates are hidden unless asked for. They still generate — an application built
   * on one must be able to keep upgrading — but a developer choosing a template for a new product
   * should not have to work out which of two similarly-named entries is the dead one.
   */
  const visible = all.filter((template) => {
    if (!options.all && template.status === 'deprecated') return false;
    if (options.category && template.category !== options.category) return false;
    return true;
  });

  if (options.json) {
    output.info(
      JSON.stringify(
        visible.map((template) => ({
          ...template,
          chain: resolveTemplateChain(template.id).map((entry) => entry.id),
        })),
        null,
        2,
      ),
    );
    return 0;
  }

  /*
   * Only the deprecated ones. Subtracting `visible` from `all` would count a category filter as
   * deprecation and tell somebody asking for `--category health` that twenty-eight templates are
   * dead.
   */
  const hidden = options.all
    ? 0
    : all.filter(
        (template) =>
          template.status === 'deprecated' &&
          (!options.category || template.category === options.category),
      ).length;

  output.info(
    style.bold(
      `${visible.length} template${visible.length === 1 ? '' : 's'}` +
        (options.category ? ` in ${options.category}` : ''),
    ),
  );
  output.blank();

  for (const category of TEMPLATE_CATEGORIES) {
    const members = visible.filter((template) => template.category === category);
    if (members.length === 0) continue;

    output.info(style.bold(`  ${CATEGORY_TITLES[category]}`));

    for (const template of members) {
      const badge = STATUS_BADGE[template.status];
      const chain = resolveTemplateChain(template.id);

      output.info(
        `    ${style.cyan(template.id.padEnd(20))} ${template.displayName}` +
          (badge ? ` ${style.dim(`(${badge})`)}` : ''),
      );

      output.detail(`      ${template.description}`);

      if (chain.length > 1) {
        // The single most useful line for somebody choosing: it says "this one already has
        // everything that one has".
        output.detail(
          `      ${style.dim(`extends ${chain.map((entry) => entry.id).join(' → ')}`)}`,
        );
      }

      if (template.status === 'deprecated' && template.supersededBy) {
        output.detail(`      ${style.dim(`use ${template.supersededBy} instead`)}`);
      }

      if (options.verbose) {
        output.detail(
          formatRows(
            [
              ['apps', template.includedApps.join(', ')],
              ['entities', template.entities.join(', ') || '—'],
              ['modules', `${template.includedModules.length} framework package(s)`],
              [
                'children',
                templateChildren(template.id)
                  .map((child) => child.id)
                  .join(', ') || '—',
              ],
              ['owner', template.owner],
              ['needs', `framework >= ${template.minimumFrameworkVersion}`],
              ['docs', template.documentation],
              ['excludes', template.outOfScope.join(', ')],
            ],
            '        ',
          ),
        );
      }

      output.blank();
    }
  }

  if (hidden > 0) {
    output.detail(`  ${hidden} deprecated template(s) hidden. Show them with --all.`);
  }

  output.detail('  trustos new <template>          create an application');
  output.detail('  trustos templates --verbose     show what each one contains');
  output.detail('  trustos templates --category health');

  return 0;
}
