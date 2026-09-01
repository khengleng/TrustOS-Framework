/**
 * @trustsystem/identity/nest
 *
 * NestJS bindings, behind a subpath so importing `@trustsystem/identity` does not pull
 * `@nestjs/common` into a worker that only validates tokens.
 */
export * from './metadata';
export * from './decorators';
export * from './authentication.guard';
export * from './assurance.guard';
