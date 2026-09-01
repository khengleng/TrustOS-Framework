/**
 * @trustsystem/module-notification/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull
 * `@nestjs/common` into a worker or a test.
 */
export * from './tokens';
export * from './notification.controller';
export * from './notification.nest-module';
