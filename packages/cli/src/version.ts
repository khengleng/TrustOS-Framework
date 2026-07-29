/**
 * CLI version.
 *
 * A literal rather than a `require('../package.json')`, so the compiled output
 * has no dependency on the package.json being present at a particular relative
 * depth — which differs between a source checkout, `dist/`, and a global npm
 * install. Kept in step with package.json by a test.
 */
export const CLI_VERSION = '0.1.0';
