/**
 * @trustos/governance-pii-policy
 *
 * Centralized masking, and controlled reveal.
 *
 * Two rules shape it. **Masking happens server-side** — a value masked in CSS is in the payload,
 * the network tab and every screenshot. And **a reveal is an event, not a state**: it has a
 * requester, a reason, an expiry and an audit record, so "who looked at this customer's number,
 * and why" is answerable.
 *
 * The audit record of a reveal carries field *names*, never values. An audit record of a reveal
 * must not itself be a reveal.
 */
export * from './masking';
