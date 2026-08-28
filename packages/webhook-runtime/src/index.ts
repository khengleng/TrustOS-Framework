/**
 * @trustos/webhook-runtime
 *
 * The sending half: destination checks, one-shot delivery, the event dispatcher and the worker
 * loop. Separate from `@trustos/webhooks` so an admin API can manage endpoints without pulling in
 * an HTTP client and a poll loop.
 *
 * `destination.ts` is the security-critical file. Read its header before changing anything in it
 * — the checks look redundant and are not.
 */
export * from './delivery';
export * from './destination';
export * from './dispatcher';
export * from './metrics';
export * from './worker';
