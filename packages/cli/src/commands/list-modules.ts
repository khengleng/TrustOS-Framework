import { listModules, resolveInstallOrder, MODULE_CATALOG } from '@trustos/module-registry';
import { formatRows, style, type Output } from '../output';

/**
 * `trustos list-modules`.
 *
 * Reads the catalog, which is data — so listing modules never imports or executes
 * one. That is the same property the installer relies on.
 */

export interface ListModulesOptions {
  json?: boolean;
  verbose?: boolean;
}

export function runListModules(options: ListModulesOptions, output: Output): number {
  const modules = listModules();

  if (options.json) {
    output.info(JSON.stringify(modules, null, 2));
    return 0;
  }

  output.info(style.bold(`TrustOS modules (${modules.length})`));
  output.blank();

  for (const entry of modules) {
    output.info(`${style.cyan(entry.metadata.id)}  ${entry.metadata.name}`);
    output.detail(`  ${entry.metadata.description}`);

    if (!options.verbose) {
      output.detail(
        `  v${entry.metadata.version} · ${entry.metadata.stability} · ${entry.routes.length} routes · ${entry.permissions.length} permissions`,
      );
      output.blank();
      continue;
    }

    output.blank();
    output.detail(
      formatRows(
        [
          ['version', `${entry.metadata.version} (${entry.metadata.stability})`],
          ['owner', entry.metadata.owner],
          ['package', entry.packaging.packageName],
          [
            'depends on',
            entry.dependencies.map((dependency) => dependency.moduleId).join(', ') || '(none)',
          ],
          ['permissions', entry.permissions.map((permission) => permission.key).join(', ')],
          ['routes', entry.routes.map((route) => `${route.method} ${route.path}`).join(', ')],
          [
            'migrations',
            entry.migrations.map((migration) => migration.schemaFragment).join(', ') || '(none)',
          ],
          [
            'environment',
            entry.environment.map((variable) => variable.name).join(', ') || '(none)',
          ],
          ['flags', entry.featureFlags.map((flag) => flag.key).join(', ') || '(none)'],
        ],
        '    ',
      ),
    );

    output.blank();
    output.detail('    extension points');
    for (const point of entry.extensionPoints) {
      output.detail(`      ${point.port.padEnd(24)} ${point.description}`);
    }

    output.blank();
    output.detail('    out of scope');
    for (const item of entry.outOfScope) output.detail(`      ${item}`);
    output.blank();
  }

  if (!options.verbose) {
    output.detail(
      '  trustos list-modules --verbose   for permissions, routes and extension points',
    );
  }

  // Stated once, in the place someone is deciding what to install: an install
  // order is not the order the ids were typed in.
  const order = resolveInstallOrder(
    MODULE_CATALOG,
    modules.map((entry) => entry.metadata.id),
  );
  output.blank();
  output.detail(
    `  Install order when adding all of them: ${order.order
      .map((entry) => entry.metadata.id)
      .join(' -> ')}`,
  );

  return 0;
}
