import { describe, expect, it } from 'vitest';
import { authorize, permissionPolicy, type AuthorizationRequest } from '@trustos/authorization';
import type { ActorContext } from '@trustos/shared-types';
import { FINANCIAL_PRODUCT_PERMISSIONS } from '@trustos/financial-product-core';
import {
  FINANCIAL_PRODUCT_POLICIES,
  PRODUCT_RESOURCE_TYPES,
  productDuplicateDecisionPolicy,
  productExecutionEnvironmentPolicy,
  productImmutabilityPolicy,
  productProviderSubstitutionPolicy,
  productResource,
  productSelfApprovalPolicy,
  productSelfPublicationPolicy,
  productSensitiveChangePolicy,
  type ProductResourceAttributes,
} from './index';

function actor(userId: string, permissions: string[] = []): ActorContext {
  return {
    userId,
    organizationId: 'org_a',
    roles: [],
    permissions,
    authenticationLevel: 'mfa',
    sessionId: 'ses_1',
  } as unknown as ActorContext;
}

function request(
  action: string,
  attributes: ProductResourceAttributes,
  userId = 'usr_checker',
  permissions: string[] = [],
): AuthorizationRequest {
  return {
    actor: actor(userId, permissions),
    action,
    organizationId: 'org_a',
    resource: productResource({
      type: PRODUCT_RESOURCE_TYPES.PRODUCT,
      id: 'merchant-wallet',
      organizationId: 'org_a',
      attributes,
    }),
  };
}

const APPROVE = FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key;
const PUBLISH = FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key;
const UPDATE = FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key;
const EXECUTE = FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_EXECUTE.key;

describe('every policy can only refuse', () => {
  it('returns deny or nothing, never allow', () => {
    for (const policy of FINANCIAL_PRODUCT_POLICIES) {
      const result = policy.evaluate(
        request(APPROVE, { authoredById: 'usr_maker', decisions: [], lifecycleStatus: 'draft' }),
      );
      expect(result?.effect ?? 'deny').toBe('deny');
    }
  });
});

describe('self-approval', () => {
  it('refuses the author approving their own version', () => {
    const result = productSelfApprovalPolicy.evaluate(
      request(APPROVE, { authoredById: 'usr_maker' }, 'usr_maker'),
    );
    expect(result?.effect).toBe('deny');
  });

  it('refuses the submitter deciding too', () => {
    const result = productSelfApprovalPolicy.evaluate(
      request(
        APPROVE,
        { authoredById: 'usr_maker', submittedById: 'usr_submitter' },
        'usr_submitter',
      ),
    );
    expect(result?.effect).toBe('deny');
  });

  it('permits somebody else', () => {
    expect(
      productSelfApprovalPolicy.evaluate(
        request(APPROVE, { authoredById: 'usr_maker' }, 'usr_checker'),
      ),
    ).toBeNull();
  });

  it('abstains rather than allowing when the author is unknown', () => {
    // An abstaining separation-of-duty policy is a control that silently does not run, so the
    // caller must always supply the field — but the policy must not *allow* when it cannot see it.
    const result = productSelfApprovalPolicy.evaluate(request(APPROVE, {}, 'usr_maker'));
    expect(result).toBeNull();
  });

  it('refuses a rejection by the author as well as an approval', () => {
    const result = productSelfApprovalPolicy.evaluate(
      request('financial.product.reject', { authoredById: 'usr_maker' }, 'usr_maker'),
    );
    expect(result?.effect).toBe('deny');
  });
});

describe('self-publication', () => {
  it('refuses the author publishing', () => {
    const result = productSelfPublicationPolicy.evaluate(
      request(PUBLISH, { authoredById: 'usr_maker', decisions: [] }, 'usr_maker'),
    );
    expect(result?.effect).toBe('deny');
  });

  it('refuses a sole approver publishing their own approval', () => {
    const result = productSelfPublicationPolicy.evaluate(
      request(
        PUBLISH,
        {
          authoredById: 'usr_maker',
          decisions: [{ actorId: 'usr_checker', level: 'RISK', decision: 'approved' }],
        },
        'usr_checker',
      ),
    );
    expect(result?.effect).toBe('deny');
  });

  it('permits an approver publishing when a second approval exists', () => {
    const result = productSelfPublicationPolicy.evaluate(
      request(
        PUBLISH,
        {
          authoredById: 'usr_maker',
          decisions: [
            { actorId: 'usr_checker', level: 'RISK', decision: 'approved' },
            { actorId: 'usr_compliance', level: 'COMPLIANCE', decision: 'approved' },
          ],
        },
        'usr_checker',
      ),
    );
    expect(result).toBeNull();
  });

  it('covers rollback as well as publication', () => {
    expect(
      productSelfPublicationPolicy.appliesTo(
        request(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_ROLLBACK.key, {}),
      ),
    ).toBe(true);
  });
});

describe('duplicate decisions', () => {
  it('refuses a second decision from the same actor', () => {
    const result = productDuplicateDecisionPolicy.evaluate(
      request(
        APPROVE,
        {
          authoredById: 'usr_maker',
          decisions: [{ actorId: 'usr_checker', level: 'RISK', decision: 'approved' }],
        },
        'usr_checker',
      ),
    );
    expect(result?.effect).toBe('deny');
  });

  it('permits a first decision', () => {
    expect(
      productDuplicateDecisionPolicy.evaluate(
        request(APPROVE, { authoredById: 'usr_maker', decisions: [] }, 'usr_checker'),
      ),
    ).toBeNull();
  });
});

describe('sensitive changes', () => {
  it('refuses a fee change travelling as a generic edit', () => {
    const result = productSensitiveChangePolicy.evaluate(
      request(UPDATE, { lifecycleStatus: 'draft', changedPaths: ['description', 'fees'] }),
    );
    expect(result?.effect).toBe('deny');
    expect(result?.reason).toContain('fees');
  });

  it('permits an edit that changes nothing sensitive', () => {
    expect(
      productSensitiveChangePolicy.evaluate(
        request(UPDATE, { lifecycleStatus: 'draft', changedPaths: ['description', 'tags'] }),
      ),
    ).toBeNull();
  });
});

describe('immutability', () => {
  it('refuses an edit to a product under review', () => {
    const result = productImmutabilityPolicy.evaluate(
      request(UPDATE, { lifecycleStatus: 'under_review' }),
    );
    expect(result?.effect).toBe('deny');
  });

  it('permits an edit to a draft', () => {
    expect(
      productImmutabilityPolicy.evaluate(request(UPDATE, { lifecycleStatus: 'draft' })),
    ).toBeNull();
  });
});

describe('execution environment', () => {
  it('refuses a draft executing in production', () => {
    const result = productExecutionEnvironmentPolicy.evaluate(
      request(EXECUTE, { lifecycleStatus: 'draft', environment: 'production' }),
    );
    expect(result?.effect).toBe('deny');
  });

  it('permits a draft executing in the sandbox', () => {
    expect(
      productExecutionEnvironmentPolicy.evaluate(
        request(EXECUTE, { lifecycleStatus: 'draft', environment: 'sandbox' }),
      ),
    ).toBeNull();
  });

  it('permits an active product executing in production', () => {
    expect(
      productExecutionEnvironmentPolicy.evaluate(
        request(EXECUTE, { lifecycleStatus: 'active', environment: 'production' }),
      ),
    ).toBeNull();
  });
});

describe('provider substitution', () => {
  it('refuses a connector the tenant has not approved', () => {
    const result = productProviderSubstitutionPolicy.evaluate(
      request(UPDATE, { approvedConnectorIds: ['rail-alpha'], requestedConnectorId: 'rail-omega' }),
    );
    expect(result?.effect).toBe('deny');
  });

  it('permits an approved connector', () => {
    expect(
      productProviderSubstitutionPolicy.evaluate(
        request(UPDATE, {
          approvedConnectorIds: ['rail-alpha'],
          requestedConnectorId: 'rail-alpha',
        }),
      ),
    ).toBeNull();
  });
});

describe('the whole policy set on the engine', () => {
  it('denies by default when nothing allows', () => {
    const decision = authorize(request(APPROVE, { authoredById: 'usr_maker' }), {
      policies: FINANCIAL_PRODUCT_POLICIES,
    });
    expect(decision.allow).toBe(false);
  });

  it('allows a permitted approval by an independent checker', () => {
    const decision = authorize(
      request(APPROVE, { authoredById: 'usr_maker', decisions: [] }, 'usr_checker', [APPROVE]),
      { policies: [...FINANCIAL_PRODUCT_POLICIES, permissionPolicy] },
    );
    expect(decision.allow).toBe(true);
  });

  it('refuses the author even when they hold the permission', () => {
    const decision = authorize(
      request(APPROVE, { authoredById: 'usr_maker', decisions: [] }, 'usr_maker', [APPROVE]),
      { policies: [...FINANCIAL_PRODUCT_POLICIES, permissionPolicy] },
    );
    expect(decision.allow).toBe(false);
    expect(decision.policyId).toBe('financial-product.self-approval');
  });
});
