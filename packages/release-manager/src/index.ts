/**
 * @trustos/release-manager
 *
 * Release channels, the support lifecycle from development to end-of-life, and release notes.
 *
 * The point of writing the lifecycle down is that support dates become *data* rather than
 * intentions: "we support the last two majors" is a sentence, but a per-release
 * `securitySupportUntil` is something `trustos upgrade` can read and act on. End-of-life is
 * announced when a release is published and the date only ever moves later — shortening support
 * after the fact is what strands deployments.
 */
export * from './lifecycle';
export * from './notes';
