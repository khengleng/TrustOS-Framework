/**
 * @trustsystem/module-scheduler/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull `@nestjs/common` into
 * a worker or a test.
 */
export * from './scheduler.nest-module';
