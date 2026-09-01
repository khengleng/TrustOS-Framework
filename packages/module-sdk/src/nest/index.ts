/**
 * @trustsystem/module-sdk/nest
 *
 * NestJS bindings, behind a subpath so importing `@trustsystem/module-sdk` does not
 * pull `@nestjs/common` into code that has no container — a worker, a test, a
 * script.
 */
export * from './host';
