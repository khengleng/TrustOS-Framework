/**
 * @trustos/governance-export-control
 *
 * An export is the one operation that produces data **outside every control that produced it**. A
 * masked field on a screen is masked; the same field in a CSV on a laptop is a file with no
 * access control, no expiry and no audit of who opened it.
 *
 * So exports are governed as their own thing: a row ceiling by classification, a justification
 * with a floor, masking that survives the file, approval above a threshold, a watermark, and an
 * expiry.
 *
 * The check that catches the real problem is the row ceiling — every mass-extraction incident
 * looks like a legitimate export with the filters removed.
 */
export * from './export-policy';
