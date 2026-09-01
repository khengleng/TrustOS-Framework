/**
 * @trustsystem/module-webhook
 *
 * Outbound webhooks with HMAC signatures, overlapping secret rotation, replay protection and delivery history.
 *
 * The implementation lives in `@trustsystem/webhooks`, `@trustsystem/webhook-runtime`; this
 * package is the module contract around it.
 */
export * from './webhook.module';
