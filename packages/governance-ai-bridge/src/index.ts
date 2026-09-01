/**
 * @trustsystem/governance-ai-bridge
 *
 * AI assistance for internal tools: summarize, explain, draft. **None of them acts.**
 *
 * That is enforced by shape rather than by rule. An AI feature returns text with a provenance
 * record; there is no return type that carries an action, no field naming an operation and no
 * path from an output to the gateway. A model cannot execute a financial adjustment because
 * there is nothing to execute one through.
 *
 * Everything goes through the TrustOS AI Gateway — this package holds no provider client and
 * imports no model SDK. The input allow-list per feature is the control that does the
 * unexpected work: it stops a summarizer from becoming a way to read a record the requester
 * could not open directly.
 */
export * from './bridge';
