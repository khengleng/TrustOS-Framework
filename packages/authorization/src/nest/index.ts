/**
 * @trustos/authorization/nest
 *
 * NestJS bindings, behind a subpath so importing `@trustos/authorization` does not
 * pull `@nestjs/common` into a worker that only evaluates a policy.
 */
export * from './metadata';
export * from './decorators';
export * from './policy.guard';
