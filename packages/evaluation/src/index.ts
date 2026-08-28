/**
 * @trustos/evaluation
 *
 * Scoring AI output: groundedness, relevance, citations, schema compliance, safety, cost, latency.
 *
 * Read the header of `metrics.ts` before using the numbers. The heuristic metrics measure overlap
 * between texts, not truth — they are good at detecting *change* and bad at detecting *error*, and
 * a report that confuses the two is worse than no report.
 */
export * from './metrics';
export * from './suite';
export * from './testing';
