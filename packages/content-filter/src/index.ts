/**
 * @trustos/content-filter
 *
 * PII detection and redaction, and risk-category signals.
 *
 * Detection is mechanical and reliable for structured identifiers — it is what makes redaction
 * before logging possible. The category rules are **keyword signals, not a classifier**, and
 * every signal carries that caveat into the review UI.
 */
export * from './categories';
export * from './pii';
