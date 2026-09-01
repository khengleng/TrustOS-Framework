/**
 * @trustsystem/analytics
 *
 * Summaries over collected telemetry: adoption, module popularity, upgrade uptake, error trends
 * and latency percentiles.
 *
 * It reads whatever the local sink holds and never fetches, stores or sends — so a dashboard works
 * in an air-gapped deployment and shows exactly what that deployment generated.
 *
 * Every summary reports the sample it was computed from. A "76% adoption" with no denominator is a
 * number that gets quoted in a slide and then in a decision; `{ value: 76, of: 17 }` is a number
 * somebody correctly distrusts.
 */
export * from './analytics';
