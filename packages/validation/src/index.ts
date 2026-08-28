/**
 * @trustos/validation
 *
 * Browser-safe: the same schema can validate a form in the admin app and the
 * request body in the API, which is the point — one definition of "valid".
 * The NestJS pipe lives behind '@trustos/validation/nest'.
 */
export { z } from 'zod';
export * from './parse';
export * from './schemas';
