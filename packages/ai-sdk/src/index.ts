/**
 * @trustsystem/ai-sdk
 *
 * The shared AI vocabulary: messages, model selection, requests, results, usage and errors.
 *
 * Every other AI package speaks this. Nothing here talks to a provider, and nothing here knows
 * what a provider is — which is what makes the platform provider-neutral rather than
 * provider-neutral-shaped.
 *
 * Read the header of `request.ts` first. The two decisions that shape everything downstream are
 * that a request carries a *requirement* rather than a model name, and that `maxOutputTokens` is
 * mandatory.
 */
export * from './errors';
export * from './messages';
export * from './request';
