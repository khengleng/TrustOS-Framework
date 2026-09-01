/**
 * @trustsystem/financial-product-api
 *
 * Stable API exposure for a composed product: route descriptors, an OpenAPI document generated
 * from the definition, idempotency, rate limiting and a headless dispatcher.
 *
 * The document is **generated**, never written beside the product. A product whose fee changed
 * and whose OpenAPI document did not is a product whose consumers were told the wrong thing, and
 * it surfaces as a partner's bug report rather than as ours.
 *
 * The dispatcher is headless for the reason `@trustsystem/template-sdk` is: one deployment runs
 * NestJS and another runs Fastify, and a dispatcher that imported either would be unusable in the
 * other. Its header documents the seven checks and why they run in that order.
 */
export * from './routes';
export * from './openapi';
export * from './dispatcher';
