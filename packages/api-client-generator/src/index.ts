/**
 * @trustos/api-client-generator
 *
 * OpenAPI to a client in TypeScript, JavaScript, Dart, Python, Java or C#.
 *
 * Every generated client has the same shape — configured auth, retry with jittered backoff, a
 * typed error, a logging hook — and **no runtime dependencies** in any target. A generated client
 * that required a particular HTTP library would impose that choice on every consuming
 * application.
 *
 * The OpenAPI support is a documented subset. What is not supported is *reported* rather than
 * silently dropped: a client missing an endpoint is a bug found at runtime by whoever tries to
 * call it.
 */
export * from './spec';
export * from './targets';
