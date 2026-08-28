/**
 * @trustos/config
 *
 * The only package permitted to read `process.env` (enforced by eslint). Every
 * other package and application receives a validated, frozen `AppConfig`.
 */
export * from './config';
export * from './env-schema';
export * from './public-config';
export * from './load-dotenv';
