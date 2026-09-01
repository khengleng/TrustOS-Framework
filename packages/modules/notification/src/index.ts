/**
 * @trustsystem/module-notification
 *
 * Templated messages over email, Telegram and webhooks.
 *
 * Read `template-engine.ts` before changing it: message templates are authored
 * by customers, which makes them untrusted input, and that is why the engine is
 * literal substitution rather than a template language.
 *
 * Every channel is a mock. The queue, retry policy, state machine, audit trail
 * and per-tenant configuration are real.
 */
export * from './config';
export * from './channels';
export * from './delivery';
export * from './template-engine';
export * from './store';
export * from './notification.service';
export * from './notification.module';
