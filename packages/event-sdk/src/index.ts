/**
 * @trustos/event-sdk
 *
 * The event envelope, its metadata, name patterns and serialization. No transport, no registry,
 * no bus — so a package that only needs to *describe* an event does not depend on one that
 * delivers it.
 *
 * Read the header of `envelope.ts` first. The fields that are not obvious — `idempotencyKey`,
 * `correlationId` versus `causationId`, `aggregate` as the ordering key — each exist for a
 * specific failure they prevent, and the reasons are recorded there.
 */
export * from './envelope';
export * from './pattern';
export * from './serialization';
