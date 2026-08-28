import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tenant isolation, asserted statically.
 *
 * A running test against two organizations needs a database, and this suite runs in the
 * generated application's default `npm test` — which does not. So these assertions check the
 * *code* rather than its behaviour, and each one targets a specific way the boundary gets
 * broken in practice.
 *
 * The behavioural equivalents live in the framework: `packages/workflow-runtime` and
 * `packages/workflow-policy` both have cross-tenant suites that exercise the engine and the
 * policies against two organizations. What cannot be tested there is *this* application's own
 * queries, which is what these check.
 */

const MODULE_DIR = __dirname;

function source(file: string): string {
  return readFileSync(join(MODULE_DIR, file), 'utf8');
}

describe('tenant isolation in the workflow module', () => {
  it('reads the business object through the tenant-scoped delegate', () => {
    const service = source('change-request.service.ts');

    /*
     * `scopedDelegate` applies the organization filter by construction, so a query written in
     * a hurry is still scoped. A raw `this.prisma.changeRequest.findMany` would not be — and
     * that is the single most common way a tenant boundary is lost.
     */
    expect(service).toContain('scopedDelegate');
    expect(service).not.toMatch(/this\.prisma\.changeRequest\.(findMany|findFirst|update)\(/);
  });

  it('takes the organization from the tenant context, never from a parameter', () => {
    const service = source('change-request.service.ts');

    // `requireOrganizationId()` reads the scope the middleware opened and throws when there is
    // none. A method signature taking `organizationId: string` would be one a caller could
    // supply, which is the bypass.
    expect(service).toContain('requireOrganizationId()');
    expect(service).not.toMatch(/\(\s*organizationId:\s*string/);
  });

  it('registers a business-object validator that checks the organization', () => {
    const service = source('change-request.service.ts');

    /*
     * Without a validator the engine refuses to start an instance in production. With one that
     * checked only the id, an instance could be started against another organization's record —
     * putting that record's id into this organization's history where every participant reads it.
     *
     * So the validator's `where` must contain both.
     */
    expect(service).toContain('BusinessObjectValidator');
    const validator = service.slice(service.indexOf('changeRequestValidator'));
    expect(validator).toContain('id: input.objectId');
    expect(validator).toContain('organizationId: input.organizationId');
  });

  it('never passes an organization id from the request into the engine', () => {
    const workflow = source('change-request-workflow.service.ts');
    const controller = source('change-request.controller.ts');

    // The organization reaches the engine through `WorkflowActor`, which is built by
    // `toWorkflowActor` from the verified actor. Anything else is client-supplied.
    expect(controller).toContain('toWorkflowActor(actor)');
    expect(workflow).not.toMatch(/organizationId:\s*(body|input|query|params)\./);
  });

  it('does not expose a route that takes an organization id', () => {
    const controller = source('change-request.controller.ts');

    // A parameter named for the tenant is a parameter somebody will trust.
    expect(controller).not.toMatch(/@(Param|Query|Body)\([^)]*organizationId/);
  });

  it('indexes every business-object query on the organization first', () => {
    const schema = readFileSync(
      join(MODULE_DIR, '..', '..', '..', '..', '..', 'prisma', 'schema', '10-product.prisma'),
      'utf8',
    );

    // Tenant scope first in a composite index, because every query filters on it — an index
    // that leads with anything else is one Postgres cannot use for the common case.
    const indexes = [...schema.matchAll(/@@index\(\[([^\]]+)\]\)/g)].map((match) => match[1]);
    expect(indexes.length).toBeGreaterThan(0);

    for (const index of indexes) {
      const columns = (index ?? '').split(',').map((column) => column.trim());
      // `workflowInstanceId` is the one legitimate exception: it is a lookup by a globally
      // unique id, and the instance it finds carries its own organization.
      if (columns[0] === 'workflowInstanceId') continue;
      expect(columns[0], `index [${index}]`).toBe('organizationId');
    }
  });
});
