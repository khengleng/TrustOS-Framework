import { describe, expect, it } from 'vitest';
import { CONSOLE_TEMPLATES } from '@trustos/governance-tool-core';
import {
  GATEWAY_OPERATIONS,
  findOperation,
  gatewayOperationSchema,
  operationsForResource,
  requireOperation,
} from './index';

describe('the operation catalog', () => {
  it('declares every path the ten consoles call', () => {
    // A console naming a path this catalog does not carry is a console calling something that
    // does not exist, and it is better found at review than at 3am.
    for (const template of CONSOLE_TEMPLATES) {
      for (const action of template.build().actions) {
        expect(
          findOperation(action.method, action.apiPath),
          `${template.id}: ${action.method} ${action.apiPath}`,
        ).not.toBeNull();
      }
    }
  });

  it('routes everything through /internal/v1', () => {
    for (const operation of GATEWAY_OPERATIONS) {
      expect(operation.path.startsWith('/internal/v1/'), operation.operationId).toBe(true);
    }
  });

  it('maps every operation to a resource', () => {
    for (const operation of GATEWAY_OPERATIONS) {
      expect(operation.resourceId.length, operation.operationId).toBeGreaterThan(0);
    }
  });

  it('names an API permission distinct from the console permission', () => {
    for (const operation of GATEWAY_OPERATIONS) {
      // The console permission decides whether a button renders; this one is the authorization.
      expect(operation.apiPermission.length, operation.operationId).toBeGreaterThan(2);
    }
  });

  it('offers no operation that publishes a financial product', () => {
    const ids = GATEWAY_OPERATIONS.map((operation) => operation.operationId);

    expect(ids).toContain('submitProduct');
    expect(ids).not.toContain('publishProduct');
    expect(ids).not.toContain('activateProduct');
  });

  it('offers no operation that posts to the ledger', () => {
    for (const operation of GATEWAY_OPERATIONS) {
      expect(operation.path).not.toMatch(/\/journals?\b/);
      expect(operation.path).not.toMatch(/\/postings?\b/);
    }

    // What exists instead: a request that runs maker-checker.
    expect(findOperation('POST', '/internal/v1/finance/adjustments/requests')).not.toBeNull();
  });

  it('offers no operation that reveals an API key', () => {
    const keyOperations = operationsForResource('trustos.api_keys');

    expect(keyOperations.map((operation) => operation.operationId)).toEqual(['revokeApiKey']);
    for (const operation of keyOperations) {
      expect(operation.path).not.toContain('reveal');
    }
  });

  it('matches a parameterised path whatever the parameter is called', () => {
    expect(findOperation('POST', '/internal/v1/operations/cases/anything/assign')).not.toBeNull();
  });

  it('refuses an undeclared path with an explanation', () => {
    expect(() => requireOperation('POST', '/internal/v1/operations/anything')).toThrow(
      /nobody mapped to a resource/,
    );
  });

  it('refuses a GET that creates something', () => {
    expect(() =>
      gatewayOperationSchema.parse({
        operationId: 'badOperation',
        path: '/internal/v1/operations/things',
        method: 'GET',
        resourceId: 'trustos.case',
        operation: 'create',
        apiPermission: 'workflow.case.create',
        createsRecord: true,
        description: 'A GET that creates.',
      }),
    ).toThrow(/retried by every proxy/);
  });

  it('refuses a traversal in a declared path', () => {
    expect(() =>
      gatewayOperationSchema.parse({
        operationId: 'traversal',
        path: '/internal/v1/../admin',
        method: 'POST',
        resourceId: 'trustos.case',
        operation: 'execute',
        apiPermission: 'workflow.case.create',
        description: 'A traversal.',
      }),
    ).toThrow();
  });

  it('answers which operations can write to the ledger', () => {
    const ledger = operationsForResource('trustos.ledger');
    expect(ledger.map((operation) => operation.operationId)).toEqual(['requestAdjustment']);
  });
});
