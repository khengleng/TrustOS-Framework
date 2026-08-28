/**
 * @trustos/errors
 *
 * Browser-safe by design: no NestJS, no Node built-ins. The NestJS exception
 * filter lives behind the '@trustos/errors/nest' subpath so importing this
 * package from a frontend never pulls a server framework into the bundle.
 */
export * from './error-codes';
export * from './api-error';
export * from './error-response';
