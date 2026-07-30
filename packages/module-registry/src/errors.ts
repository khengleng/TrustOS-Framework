/**
 * Registry failures.
 *
 * A single error type with a machine-readable `code`, so the CLI can decide
 * exit status and phrasing without matching on message text — the same contract
 * `GeneratorError` provides for the generator.
 */
export type ModuleRegistryErrorCode =
  | 'catalog_invalid'
  | 'module_not_found'
  | 'dependency_missing'
  | 'dependency_cycle'
  | 'version_conflict'
  | 'already_registered'
  | 'lifecycle_failed';

export class ModuleRegistryError extends Error {
  readonly code: ModuleRegistryErrorCode;
  /** Actionable next step, printed by the CLI under the message. */
  readonly hint: string | undefined;

  constructor(code: ModuleRegistryErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ModuleRegistryError';
    this.code = code;
    this.hint = hint;
  }
}

export function isModuleRegistryError(value: unknown): value is ModuleRegistryError {
  return value instanceof ModuleRegistryError;
}
