/**
 * @trustsystem/framework-health
 *
 * Whether the platform is in a state somebody can keep operating.
 *
 * Distinct from `@trustsystem/observability`, which answers "is this process up". The two go wrong at
 * completely different speeds — a process is unhealthy for minutes, a platform for quarters — and
 * every signal here is chosen because it *precedes* a failure rather than reporting one: an
 * unsupported version is an upgrade that will become urgent, unsigned modules are a supply chain
 * that will be questioned during an incident, an expiring licence is an outage in a month with a
 * purchase order attached.
 */
export * from './health';
