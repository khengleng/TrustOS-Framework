import type { Output } from '../output';
import { style } from '../output';

/**
 * Commands that are registered but not implemented in this phase.
 *
 * `add-module` graduated out of here in phase 3. `upgrade` remains: it explains
 * what it will do and, more usefully, what to do today instead. Exit status is
 * non-zero so a script that calls one does not mistake "not implemented" for
 * success.
 */

export function runUpgrade(output: Output): number {
  output.warn('`trustos upgrade` is not implemented yet.');
  output.blank();
  output.info(
    'It will migrate a generated application to a newer framework or template\n' +
      'version, applying the migration notes recorded in the template registry.',
  );
  output.blank();
  output.info(style.bold('Today'));
  output.detail(
    '  Bump the @trustos/* versions in package.json, read the template migration\n' +
      '  notes (trustos list-templates --verbose), and run the test suite.',
  );
  output.blank();
  output.detail(
    '  Framework migrations are deliberately out of scope for this phase — an\n' +
      '  automated upgrade that silently rewrites security-relevant wiring is worse\n' +
      '  than a documented manual one.',
  );
  return 2;
}
