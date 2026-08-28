/**
 * @trustos/security-policy
 *
 * The security decisions an operator is allowed to make, as one typed object
 * validated before a port is bound.
 *
 * Read `productionPolicyProblems` first: every entry in it is a configuration
 * that boots, serves traffic, and is wrong — a development identity provider in
 * production, a wildcard CORS origin, an access token that outlives its refresh
 * token, a session with no meaningful end.
 */
export * from './policy';
export * from './load';
export * from './rate-limit';
export * from './secrets';
