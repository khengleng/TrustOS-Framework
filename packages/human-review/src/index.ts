/**
 * @trustsystem/human-review
 *
 * The review queue for AI output: approve, reject, request changes, escalate.
 *
 * The escape hatch that makes the rest of the platform honest — guardrails reduce the rate of bad
 * output and never eliminate it. Pending output is not readable through this API, because a flag
 * beside the text gets ignored and a thrown error does not.
 */
export * from './review';
export * from './testing';
