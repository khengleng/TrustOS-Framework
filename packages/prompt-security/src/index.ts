/**
 * @trustos/prompt-security
 *
 * Prompt-injection and jailbreak detection over untrusted input.
 *
 * Read the header of `injection.ts` before relying on this. Prompt injection is not solved, and a
 * detector that claimed to catch everything would be more dangerous than none. What stops a
 * successful injection doing damage is tool permissions, tenant scoping and human approval; this
 * buys early warning and an audit trail.
 */
export * from './injection';
