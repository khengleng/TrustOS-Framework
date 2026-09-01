/**
 * @trustsystem/quality-gates
 *
 * The eleven gates a change clears before it ships.
 *
 * The framework's opinion, stated once: architecture, security and testing cannot be waived — a
 * waiver on a security gate is a gate that does not exist, because the first time it fires under
 * deadline pressure it is used and then it always is. Everything else may be waived with a
 * recorded reason, an owner and an *expiry*; a waiver with no expiry is a permanent exemption
 * written in the language of a temporary one. Performance never blocks, because a number from a
 * shared CI machine teaches people to re-run until it passes.
 *
 * No gate runs a tool. Each takes the result of one, so a gate behaves identically in CI, on a
 * laptop and in a pre-commit hook.
 */
export * from './gates';
