/**
 * @trustos/session-security
 *
 * Sessions, refresh-token rotation with reuse detection, the four session limits, and
 * the browser hardening that protects a session: security headers, CORS and CSRF.
 *
 * Read the reuse-detection branch in `sessions.ts` before changing anything here: it
 * is the only detection the framework has for a stolen refresh token, and the cost it
 * imposes on a legitimate user is deliberate.
 *
 * `csrf.ts` explains why a bearer-token API needs no CSRF protection and where that
 * reasoning stops being true — which is the part that gets a deployment caught.
 */
export * from './sessions';
export * from './in-memory-store';
export * from './http-security';
export * from './csrf';
