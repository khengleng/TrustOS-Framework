/**
 * @trustsystem/module-search/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull
 * `@nestjs/common` into a worker or a test.
 */
export * from './tokens';
export * from './search.controller';
export * from './search.nest-module';
