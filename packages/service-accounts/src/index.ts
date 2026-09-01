/**
 * @trustsystem/service-accounts
 *
 * Machine identities.
 *
 * The reason this is not a user account with a strong password: an integration on a
 * person's account dies when they leave, breaks when their password rotates, cannot
 * satisfy their MFA from a cron job, and puts their name on every audit record for
 * work they did not do.
 *
 * A service account therefore has no password, no MFA, no interactive login, and is
 * never `isSuperAdmin`.
 */
export * from './service';
export * from './authenticator';
export * from './in-memory-store';
export * from './prisma-store';
