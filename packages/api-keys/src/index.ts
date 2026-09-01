/**
 * @trustsystem/api-keys
 *
 * API keys: generated once, hashed immediately, never recoverable.
 *
 * The rule everything follows from is in `service.ts`: the plaintext key exists for
 * the duration of one response. A "show key" endpoint would require storing it, and
 * a key that can be read from the database is a key that leaks with the database.
 */
export * from './key';
export * from './scopes';
export * from './ip-allowlist';
export * from './service';
export * from './in-memory-store';
export * from './authenticator';
export * from './prisma-store';
