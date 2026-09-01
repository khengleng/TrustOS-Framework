/**
 * @trustsystem/auth
 *
 * Email and password only, on purpose. Google, Apple, passkeys and Keycloak
 * are deliberately absent from this phase — see docs/architecture.md.
 */
export * from './password';
export * from './tokens';
export * from './ports';
export * from './events';
export * from './auth.service';
export * from './prisma-auth-store';
export * from './nest/jwt-auth.guard';
export * from './nest/decorators';
