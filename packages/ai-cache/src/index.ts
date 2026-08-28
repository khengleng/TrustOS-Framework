/**
 * @trustos/ai-cache
 *
 * Prompt, completion and embedding caches with TTL, invalidation and metrics.
 *
 * The cache key is a tenant-isolation problem, and `buildCacheKey` takes a context rather than a
 * string so a key that omits the organization cannot be constructed. Read the header of
 * `cache.ts` — the cross-tenant leak this prevents has no error and no log line.
 */
export * from './cache';
