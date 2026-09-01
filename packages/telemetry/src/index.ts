/**
 * @trustsystem/telemetry
 *
 * Local-first usage, performance and error signals.
 *
 * Three properties, enforced by the code rather than promised in a policy. It is **off unless
 * explicitly switched on** — `enabled` has no default, so turning it on is always visible in a
 * diff. It is **local-first with no default destination** — the framework ships no exporter and
 * has no endpoint, because a framework with a hardcoded telemetry URL phones home whatever its
 * documentation says. And **tenant data cannot be recorded structurally**: an event has a name,
 * bounded low-cardinality dimensions and numbers, with no free-text field for a customer name to
 * land in.
 */
export * from './telemetry';
