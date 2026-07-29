/**
 * Generator failures.
 *
 * A single error type with a machine-readable `code` so the CLI can decide
 * exit status and phrasing without string-matching messages.
 */
export type GeneratorErrorCode =
  | 'invalid_input'
  | 'unsafe_path'
  | 'target_not_empty'
  | 'template_not_found'
  | 'template_invalid'
  | 'framework_incompatible'
  | 'render_failed'
  | 'write_failed'
  | 'rollback_failed';

export class GeneratorError extends Error {
  readonly code: GeneratorErrorCode;
  /** Actionable next step, printed by the CLI under the message. */
  readonly hint: string | undefined;

  constructor(code: GeneratorErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'GeneratorError';
    this.code = code;
    this.hint = hint;
  }
}

export function isGeneratorError(value: unknown): value is GeneratorError {
  return value instanceof GeneratorError;
}
