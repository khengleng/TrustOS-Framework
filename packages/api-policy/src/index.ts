/**
 * @trustsystem/api-policy
 *
 * The deployment-specific half of API access, as policy documents.
 *
 * The floor — status, environment, entitlement, version, scope — stays in code, where an operator
 * cannot weaken it through configuration. What lives here is everything above the floor, and it
 * can only ever refuse.
 */
export * from './api-policy';
