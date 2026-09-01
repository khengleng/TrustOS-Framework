/**
 * @trustsystem/sli
 *
 * Indicators as ratios of good events to valid events, aggregated from counts.
 *
 * The two positions this package takes: an unobserved window reports `null` rather than 100%, and
 * a counter reporting more good events than valid ones is refused rather than clamped.
 */
export * from './indicator';
