/**
 * @trustsystem/module-file-storage/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull
 * `@nestjs/common` into a worker or a test.
 */
export * from './tokens';
export * from './file-storage.controller';
export * from './file-storage.nest-module';
