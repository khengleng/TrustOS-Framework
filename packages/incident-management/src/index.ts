/**
 * @trustos/incident-management
 *
 * Incidents with an append-only timeline and a closing gate.
 *
 * A SEV1 or SEV2 closes only with a postmortem whose corrective actions have owners and dates.
 * Severity is never derived from symptoms — it is a judgement about impact, and a rule that got it
 * wrong would be overridden until the field meant nothing.
 */
export * from './incident';
