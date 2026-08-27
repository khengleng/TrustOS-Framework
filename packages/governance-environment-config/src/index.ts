/**
 * @trustos/governance-environment-config
 *
 * DEV, UAT and PROD as separate configurations with separate credentials, and the governed
 * promotion between them.
 *
 * The rule that matters: **a lower-environment credential must never authenticate to
 * production.** It is violated the same way every time — somebody copies a `.env` to debug
 * something and it *works*, so nobody notices until an export.
 * `assertNoCrossEnvironmentCredential` refuses a shared credential reference at load rather than
 * at first use, because by first use it has already worked once.
 */
export * from './environments';
