import { listTemplates } from '@trustos/template-registry';
import type { Output } from '../output';
import { formatRows, style } from '../output';

export interface ListTemplatesOptions {
  json?: boolean;
  verbose?: boolean;
}

/** `trustos list-templates`. */
export function runListTemplates(options: ListTemplatesOptions, output: Output): number {
  const templates = listTemplates();

  if (options.json) {
    // Machine-readable output goes to stdout unadorned so it can be piped
    // into jq without stripping decoration first.
    output.info(JSON.stringify(templates, null, 2));
    return 0;
  }

  output.info(style.bold(`${templates.length} approved templates`));
  output.blank();

  for (const template of templates) {
    output.info(`  ${style.cyan(template.id)}  ${style.dim(`v${template.version}`)}`);
    output.info(`    ${template.displayName} — ${template.description}`);

    if (options.verbose) {
      output.detail(
        formatRows(
          [
            ['apps', template.includedApps.join(', ')],
            ['entities', template.entities.join(', ') || '—'],
            ['deploy', template.deploymentTargets.join(', ')],
            ['owner', template.owner],
            ['needs', `framework >= ${template.minimumFrameworkVersion}`],
            ['excludes', template.outOfScope.join(', ')],
          ],
          '      ',
        ),
      );
    }
    output.blank();
  }

  output.detail('  trustos new <template>            create an application');
  output.detail('  trustos list-templates --verbose  show what each template contains');
  return 0;
}
