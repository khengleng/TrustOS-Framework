import { describe, expect, it } from 'vitest';
import { STANDARD_RESOURCE_IDS } from '@trustos/governance-tool-core';
import {
  ResourceRegistry,
  STANDARD_RESOURCE_CLASSES,
  classifyStandardResource,
  resourceRegistrationSchema,
} from './index';

function registration(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: 'reporting.transactions',
    name: 'Transaction replica',
    description: 'A read-only replica of the transaction table.',
    type: 'reporting_database',
    environment: 'prod',
    owner: 'usr_data',
    businessOwner: 'usr_finance',
    technicalOwner: 'usr_platform',
    dataClassification: 'restricted',
    accessClass: 'read_only',
    credentialRef: 'secret://reporting/prod/readonly',
    allowedGroups: ['operations', 'finance'],
    permittedOperations: ['read', 'search', 'aggregate'],
    exposedFields: ['reference', 'status', 'amountMinorUnits', 'createdAt'],
    approvalStatus: 'approved',
    approvedBy: 'usr_security',
    lastReviewDate: '2026-01-01T00:00:00.000Z',
    nextReviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('registering a resource', () => {
  it('accepts a well-formed registration', () => {
    expect(() => resourceRegistrationSchema.parse(registration())).not.toThrow();
  });

  it('refuses a resource that exposes a credential-shaped column', () => {
    expect(() =>
      resourceRegistrationSchema.parse(
        registration({ exposedFields: ['reference', 'passwordHash'] }),
      ),
    ).toThrow(/Class C/);
  });

  it('permits a named exception for a false positive', () => {
    expect(() =>
      resourceRegistrationSchema.parse(
        registration({
          exposedFields: ['period', 'inputTokens'],
          fieldExceptions: ['inputTokens'],
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a Class A resource that declares a mutation', () => {
    expect(() =>
      resourceRegistrationSchema.parse(registration({ permittedOperations: ['read', 'update'] })),
    ).toThrow(/credentials cannot write/);
  });

  it('refuses a Class C resource that lists fields', () => {
    expect(() =>
      resourceRegistrationSchema.parse(
        registration({
          accessClass: 'forbidden',
          permittedOperations: ['read'],
          exposedFields: ['secretValue'],
        }),
      ),
    ).toThrow();
  });

  it('refuses a registrant who approved their own production resource', () => {
    expect(() =>
      resourceRegistrationSchema.parse(registration({ approvedBy: 'usr_data' })),
    ).toThrow(/approved their own production resource/);
  });

  it('refuses an approved production resource with no approver', () => {
    expect(() => resourceRegistrationSchema.parse(registration({ approvedBy: null }))).toThrow(
      /records who approved it/,
    );
  });

  it('has no field a credential could be pasted into', () => {
    expect(() =>
      resourceRegistrationSchema.parse(registration({ credential: 'hunter2' })),
    ).toThrow();
  });
});

describe('the registry', () => {
  it('scopes a resource to its environment', () => {
    const registry = new ResourceRegistry([
      resourceRegistrationSchema.parse(
        registration({
          environment: 'dev',
          approvedBy: 'usr_security',
          credentialRef: 'secret://reporting/dev/readonly',
        }),
      ),
      resourceRegistrationSchema.parse(registration()),
    ]);

    expect(registry.find('dev', 'reporting.transactions')?.credentialRef).toBe(
      'secret://reporting/dev/readonly',
    );
    expect(registry.find('uat', 'reporting.transactions')).toBeUndefined();
  });

  it('refuses a duplicate registration in one environment', () => {
    const registry = new ResourceRegistry([resourceRegistrationSchema.parse(registration())]);
    expect(() => registry.register(registration())).toThrow(/already registered/);
  });

  it('refuses an unregistered resource with an explanation', () => {
    const registry = new ResourceRegistry();
    expect(() => registry.require('prod', 'reporting.nothing')).toThrow(/nobody classified/);
  });

  it('refuses a resource that is not approved', () => {
    const registry = new ResourceRegistry([
      resourceRegistrationSchema.parse(registration({ approvalStatus: 'draft', approvedBy: null })),
    ]);

    const decision = registry.decide({
      environment: 'prod',
      resourceId: 'reporting.transactions',
      operation: 'search',
      actorGroups: ['finance'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('draft');
  });

  it('refuses an actor whose groups are not allowed', () => {
    const registry = new ResourceRegistry([resourceRegistrationSchema.parse(registration())]);

    expect(
      registry.decide({
        environment: 'prod',
        resourceId: 'reporting.transactions',
        operation: 'search',
        actorGroups: ['customer_support'],
      }).allowed,
    ).toBe(false);
  });

  it('permits an allowed group performing a permitted read', () => {
    const registry = new ResourceRegistry([resourceRegistrationSchema.parse(registration())]);

    expect(
      registry.decide({
        environment: 'prod',
        resourceId: 'reporting.transactions',
        operation: 'search',
        actorGroups: ['finance'],
      }).allowed,
    ).toBe(true);
  });

  it('reports resources whose review has passed', () => {
    const registry = new ResourceRegistry([resourceRegistrationSchema.parse(registration())]);

    expect(registry.overdueReviews('prod', new Date('2027-06-01'))).toHaveLength(1);
    expect(registry.overdueReviews('prod', new Date('2026-06-01'))).toHaveLength(0);
  });
});

describe('the standard classification', () => {
  it('classifies every resource the consoles reference', () => {
    for (const resourceId of Object.values(STANDARD_RESOURCE_IDS)) {
      expect(classifyStandardResource(resourceId), resourceId).not.toBeNull();
    }
  });

  it('makes every reporting source read-only and every TrustOS API Class B', () => {
    for (const [resourceId, accessClass] of Object.entries(STANDARD_RESOURCE_CLASSES)) {
      if (resourceId.startsWith('reporting.') || resourceId.startsWith('reference.')) {
        expect(accessClass, resourceId).toBe('read_only');
      }
      if (resourceId.startsWith('trustos.')) {
        expect(accessClass, resourceId).toBe('api_only');
      }
    }
  });

  it('returns null for something it does not know', () => {
    expect(classifyStandardResource('somebody.invented')).toBeNull();
  });
});
