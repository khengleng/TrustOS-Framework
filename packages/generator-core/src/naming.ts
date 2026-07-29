import { GeneratorError } from './errors';

/**
 * Input validation for everything a user types.
 *
 * The generator's threat model treats every prompt answer as hostile: values
 * end up in file paths, in `package.json`, and interpolated into generated
 * source. Rejecting early — with a specific message — is cheaper than escaping
 * correctly at a dozen later call sites.
 */

/**
 * Names that must never become a directory or package.
 *
 * `node_modules`, `.git` and the Windows device names are the ones that cause
 * real damage: a project called `CON` cannot be created or deleted on Windows,
 * and a project called `node_modules` breaks resolution for everything above it.
 */
export const RESERVED_NAMES = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  'src',
  'test',
  'tests',
  'npm',
  'trustos',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const APPLICATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates the application name, which is the one piece of user input that
 * becomes a directory name.
 */
export function assertValidApplicationName(name: string): string {
  const value = name.trim();

  if (!value) {
    throw new GeneratorError('invalid_input', 'Application name is required.');
  }
  if (value.length > 64) {
    throw new GeneratorError('invalid_input', 'Application name must be 64 characters or fewer.');
  }
  if (!APPLICATION_NAME.test(value)) {
    throw new GeneratorError(
      'invalid_input',
      `Invalid application name "${value}".`,
      'Use lowercase letters, digits and single hyphens, e.g. "merchant-portal".',
    );
  }
  if (RESERVED_NAMES.has(value.toLowerCase())) {
    throw new GeneratorError(
      'invalid_input',
      `"${value}" is a reserved name and cannot be used as an application name.`,
    );
  }
  return value;
}

/**
 * Validates an npm package name against the registry rules that matter here:
 * optional scope, lowercase, no leading dot or underscore, URL-safe.
 */
export function assertValidPackageName(name: string): string {
  const value = name.trim();

  if (!value) {
    throw new GeneratorError('invalid_input', 'Package name is required.');
  }
  if (value.length > 214) {
    throw new GeneratorError('invalid_input', 'Package name must be 214 characters or fewer.');
  }
  if (value !== value.toLowerCase()) {
    throw new GeneratorError('invalid_input', 'Package name must be lowercase.');
  }
  if (/^[._]/.test(value)) {
    throw new GeneratorError(
      'invalid_input',
      'Package name must not start with a dot or underscore.',
    );
  }

  const scoped = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
  const plain = /^[a-z0-9][a-z0-9._-]*$/;

  if (!scoped.test(value) && !plain.test(value)) {
    throw new GeneratorError(
      'invalid_input',
      `Invalid package name "${value}".`,
      'Use "my-product" or "@scope/my-product".',
    );
  }

  const unscoped = value.includes('/') ? (value.split('/')[1] as string) : value;
  if (RESERVED_NAMES.has(unscoped)) {
    throw new GeneratorError('invalid_input', `"${value}" is a reserved package name.`);
  }

  return value;
}

/**
 * Values interpolated into generated source.
 *
 * Template *files* are trusted — they come from this repository and are
 * reviewed. User input is only ever *data*. But that data lands inside
 * TypeScript string literals and JSON, so anything that could terminate a
 * literal or open a template expression is rejected rather than escaped:
 * escaping correctly for every target syntax is a losing game.
 */
const FORBIDDEN_IN_VALUES = [
  { pattern: /[`]/, reason: 'backticks' },
  { pattern: /\$\{/, reason: 'template-literal interpolation (${)' },
  { pattern: /<\/?script/i, reason: 'script tags' },
  { pattern: /\{\{/, reason: 'Handlebars expressions ({{)' },
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  { pattern: /[\u0000-\u001f\u007f]/, reason: 'control characters' },
];

export function assertSafeValue(name: string, value: unknown): void {
  if (typeof value !== 'string') return;

  for (const { pattern, reason } of FORBIDDEN_IN_VALUES) {
    if (pattern.test(value)) {
      throw new GeneratorError(
        'invalid_input',
        `Value for "${name}" contains ${reason}, which is not allowed.`,
        'Generated files are source code; values are inserted verbatim.',
      );
    }
  }
}

/** Free-text fields shown in a README or a UI heading. */
export function assertValidDisplayText(name: string, value: string, max = 200): string {
  const text = value.trim();
  if (!text) throw new GeneratorError('invalid_input', `${name} is required.`);
  if (text.length > max) {
    throw new GeneratorError('invalid_input', `${name} must be ${max} characters or fewer.`);
  }
  assertSafeValue(name, text);
  return text;
}

export function assertValidPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GeneratorError('invalid_input', `Invalid port ${port}. Use 1-65535.`);
  }
  return port;
}

/** Role names seeded into the generated product. */
export function parseRoleList(input: string): string[] {
  const roles = input
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  if (roles.length === 0) {
    throw new GeneratorError('invalid_input', 'At least one role is required.');
  }

  for (const role of roles) {
    if (!/^[a-z][a-z0-9_]*$/.test(role)) {
      throw new GeneratorError(
        'invalid_input',
        `Invalid role name "${role}".`,
        'Use lowercase letters, digits and underscores, e.g. "store_manager".',
      );
    }
  }

  return [...new Set(roles)];
}
