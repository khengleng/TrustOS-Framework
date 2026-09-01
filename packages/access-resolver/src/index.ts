/**
 * @trustsystem/access-resolver
 *
 * Turns a verified subject into the roles and permissions it holds, from the database
 * rather than from the token. Every application in this framework shipped a resolver
 * that returned null, which is why anyone below platform-root could authenticate and
 * then do nothing.
 */
export * from './prisma-access-resolver';
