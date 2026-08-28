/**
 * @trustos/security-events
 *
 * Structured security events: what happened to the perimeter.
 *
 * Distinct from the audit trail, which answers "who changed what". A failed login
 * has no audit record — nothing changed — and it is the single most useful
 * security event there is.
 *
 * Every event is redacted before it reaches a sink, and a sink failure never
 * propagates: recording must not be able to fail a request it was only observing.
 */
export * from './events';
export * from './sinks';
