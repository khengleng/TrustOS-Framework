/**
 * @trustos/code-generator
 *
 * One entity in, a working vertical slice out: Prisma model, types, repository, service,
 * controller, isolation test and documentation.
 *
 * Two properties are why a generator is safer than copying an existing file. **Everything is
 * tenant-scoped, with no flag to turn it off** — a generator that could emit an unscoped
 * repository would eventually emit one, and the endpoint returns every tenant's rows while passing
 * every test written against a single-tenant fixture. **Every write is audited and every route
 * carries a permission**, both derived from the declaration, because the most common defect in
 * hand-written CRUD is the fourth endpoint added a month later that has neither.
 *
 * It emits files as data and writes nothing, which is what makes `--dry-run` the same code path as
 * the real run.
 */
export * from './slice';
export * from './generate';
