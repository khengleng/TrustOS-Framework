/**
 * @trustos/api-consumer
 *
 * Who may call what, at which major version, with which scopes.
 *
 * Holds credential *references* and no credential material: keys stay in `@trustos/api-keys`.
 * The separation is what lets an entitlement outlive a rotation instead of being re-granted by
 * copying whatever the old key had.
 */
export * from './consumer';
