/**
 * @trustsystem/governance-audit-bridge
 *
 * Forwards Governance Tool actions into the **TrustOS** audit trail, not into a trail of its own.
 * Two audit trails means two answers to "what happened", and during an investigation somebody has
 * to decide which is right.
 *
 * What the bridge adds is provenance: which internal application caused this, in which
 * environment, for which stated reason, under which approval, correlated to which request. A
 * TrustOS record says "usr_7 froze wallet wlt_3"; with the bridge it says where from and why.
 */
export * from './bridge';
