/**
 * @trustos/prompt-registry
 *
 * Versioned, approved, immutable prompts with typed variables and a restricted template language.
 *
 * A published version never changes. An evaluation that scored version 3 must still be describing
 * the prompt that ran, and a prompt that can be edited in place makes every evaluation record
 * worthless.
 *
 * Read the header of `template.ts` before changing the renderer: substituted values are never
 * re-scanned, and that single property is what stops server-side template injection.
 */
export * from './registry';
export * from './template';
export * from './testing';
