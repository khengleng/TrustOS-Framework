/**
 * @trustsystem/template-sdk
 *
 * The building blocks every TrustOS industry template shares.
 *
 * Two rules shaped everything in here.
 *
 * **It is headless.** No React, no charting library, no storage client, no HTTP client. A
 * template generates a NestJS API *and* a Next.js admin from one dependency tree; anything that
 * imports a renderer is unusable in half of it. What the SDK ships is descriptors — a table, a
 * form, a filter set, a dashboard — plus the pure logic that operates on them.
 *
 * **It reuses the framework rather than restating it.** Validation primitives come from
 * `@trustsystem/validation`, errors from `@trustsystem/errors`, permissions are the same keys `@trustsystem/rbac`
 * enforces, money is a string on its way to `@trustsystem/financial-core`. The SDK adds the layer
 * above those — the part where a screen, an endpoint and a permission have to agree — and nothing
 * below it.
 *
 * The recurring bug it exists to prevent: a field added to the form and forgotten in the table, a
 * filter offered by the UI and not allowed by the API, a column hidden with CSS while the value
 * is still in the payload. All three come from describing one thing twice. There is one
 * description here, and the server reads it first.
 */

export * from './permissions';
export * from './navigation';
export * from './forms';
export * from './tables';
export * from './pagination';
export * from './filters';
export * from './search';
export * from './dashboards';
export * from './charts';
export * from './uploads';
export * from './notifications';
export * from './crud';
