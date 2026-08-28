/**
 * @trustos/governance-resource-policy
 *
 * The approved resource registry: what an internal application may reach, under which access
 * class, with whose approval.
 *
 * The question it exists to answer during an incident is **which internal tools can see this
 * data, and who approved that** — which is unanswerable if a console's data sources are code.
 *
 * Three refusals at registration: a resource may not expose a Class C field, a Class A resource
 * may not declare a mutation, and a production resource needs an approver who is not the
 * registrant.
 */
export * from './registry';
