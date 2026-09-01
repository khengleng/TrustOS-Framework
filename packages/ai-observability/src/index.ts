/**
 * @trustsystem/ai-observability
 *
 * What the AI platform did, in numbers: requests, latency, failures, retries, provider health,
 * tokens, cost, cache hit rate, agent and prompt usage.
 *
 * Metadata only — never prompt or completion text. An observability store is read by more people,
 * exported to more places and kept for longer than any other store in a system.
 */
export * from './telemetry';
export * from './testing';
