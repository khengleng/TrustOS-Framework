/**
 * @trustsystem/provider-sdk
 *
 * The contract every external-system adapter implements: initialize, health, capabilities,
 * configuration, shutdown.
 *
 * The framework ships no implementations of it — not one. This is the seam; a product built on
 * the framework brings the adapters, and that distinction is the reason phase 6 stops here.
 */
export * from './provider';
