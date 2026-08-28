/**
 * @trustos/governance-data-access
 *
 * The choke point: every read and every write an internal application performs goes through
 * `DataAccessGuard`, and there is no second path.
 *
 * That matters more than the individual checks. A guard that covers most call sites is a guard
 * with a bypass, and the bypass is always the one somebody added in a hurry — so the guard
 * produces *plans* and the runtime has no way to issue a query except by asking for one.
 *
 * The rule that never bends: **a mutation outside Class B is refused**, and a mutation not routed
 * through `/internal/v1` is refused. A direct write skips authorization, workflow, maker-checker
 * and audit, and it looks exactly like a working feature.
 */
export * from './enforce';
