/**
 * @trustos/policy-decision-log
 *
 * Every policy decision, recorded — with the **policy version**, which is the field that makes
 * the log worth keeping. Without it a record says "we denied this in March", which is
 * unfalsifiable: the policy has changed since. With it the decision is re-derivable, which is the
 * difference between a log and evidence.
 *
 * Sensitive attributes are hashed rather than stored. A decision about whether to reveal a
 * customer's identifier must not record the identifier.
 *
 * Unlike the audit trail, a failed write here is **not** swallowed. An audit trail degrades
 * acceptably under an outage; a decision log is the evidence that an authorization decision was
 * made correctly, and a permission granted with no record of why is worse than one refused.
 */
export * from './log';
