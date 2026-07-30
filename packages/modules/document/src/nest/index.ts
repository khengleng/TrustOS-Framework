/**
 * @trustos/module-document/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull
 * `@nestjs/common` into a worker or a test.
 */
export * from './tokens';
export * from './document.controller';
export * from './document.nest-module';
