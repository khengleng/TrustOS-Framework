/**
 * @trustos/module-search
 *
 * Global search across registered adapters, with permission filtering, tenant
 * verification, ranking and pagination.
 *
 * There is no index and no external engine: adapters query what the owning module
 * already stores, so a hit is as current as the row and there is no second copy of
 * customer data to keep tenant-correct.
 */
export * from './config';
export * from './adapter';
export * from './ranking';
export * from './search.service';
export * from './search.module';
