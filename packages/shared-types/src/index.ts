/**
 * @trustsystem/shared-types
 *
 * The only package that both server and browser code may depend on for domain
 * shapes. It is intentionally runtime-free: no dependencies, no side effects,
 * nothing that could drag a secret or a Node built-in into a browser bundle.
 */
export * from './ids';
export * from './entities';
export * from './context';
export * from './pagination';
export * from './api-contracts';
