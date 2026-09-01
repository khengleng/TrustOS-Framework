import { describe, expect, it } from 'vitest';
import {
  ACCESS_CLASSES,
  CONSOLE_TEMPLATES,
  templatesWithheldFrom,
  consoleCatalogFor,
  FORBIDDEN_FIELD_PATTERNS,
  GOVERNANCE_PERMISSIONS,
  GOVERNANCE_ROLES,
  STANDARD_RESOURCE_IDS,
  accessRefused,
  actionSchema,
  decideAccess,
  enterpriseGovernanceConsole,
  findConsoleTemplate,
  forbiddenFields,
  governanceSegregationViolations,
  isForbiddenField,
  isMutation,
  parseInternalApplication,
  resourcesUsedBy,
} from './index';

function anAction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'freeze-wallet',
    label: 'Freeze wallet',
    resourceId: 'trustos.wallet',
    operation: 'execute',
    apiPath: '/internal/v1/support/wallets/:walletRef/freeze',
    method: 'POST',
    permission: 'governance.console.support',
    requiresReason: true,
    ...overrides,
  };
}

describe('the three access classes', () => {
  it('refuses Class C outright, under every operation', () => {
    for (const operation of [
      'read',
      'search',
      'aggregate',
      'create',
      'update',
      'delete',
      'execute',
    ] as const) {
      const decision = decideAccess({
        resourceId: 'secrets.vault',
        accessClass: 'forbidden',
        operation,
        permittedOperations: [operation],
      });

      // There is no permission that grants it, no reveal that surfaces it and no export that
      // includes it. A class that could be unlocked is a class somebody unlocks during an incident.
      expect(decision.allowed, operation).toBe(false);
    }
  });

  it('refuses a mutation against a Class A read-only source', () => {
    const decision = decideAccess({
      resourceId: 'reporting.transactions',
      accessClass: 'read_only',
      operation: 'update',
      permittedOperations: ['read', 'search', 'update'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('skipped authorization');
  });

  it('permits a read against a Class A source', () => {
    expect(
      decideAccess({
        resourceId: 'reporting.transactions',
        accessClass: 'read_only',
        operation: 'search',
        permittedOperations: ['read', 'search'],
      }).allowed,
    ).toBe(true);
  });

  it('permits a mutation against a Class B resource that declares it', () => {
    expect(
      decideAccess({
        resourceId: 'trustos.wallet',
        accessClass: 'api_only',
        operation: 'execute',
        permittedOperations: ['read', 'execute'],
      }).allowed,
    ).toBe(true);
  });

  it('refuses an operation the resource does not declare, whatever its class', () => {
    expect(
      decideAccess({
        resourceId: 'trustos.wallet',
        accessClass: 'api_only',
        operation: 'delete',
        permittedOperations: ['read', 'execute'],
      }).allowed,
    ).toBe(false);
  });

  it('turns a refusal into a forbidden error carrying the class', () => {
    const error = accessRefused(
      decideAccess({
        resourceId: 'secrets.vault',
        accessClass: 'forbidden',
        operation: 'read',
        permittedOperations: ['read'],
      }),
    );

    expect(error.status).toBe(403);
    expect(error.context?.governanceAccessClass).toBe('forbidden');
  });

  it('classifies mutations correctly', () => {
    expect(isMutation('read')).toBe(false);
    expect(isMutation('aggregate')).toBe(false);
    expect(isMutation('execute')).toBe(true);
    expect(isMutation('delete')).toBe(true);
  });

  it('ships exactly three classes', () => {
    expect([...ACCESS_CLASSES]).toEqual(['read_only', 'api_only', 'forbidden']);
  });
});

describe('forbidden fields', () => {
  it('catches a credential whatever its spelling', () => {
    for (const field of [
      'password_hash',
      'passwordHash',
      'PASSWORD-HASH',
      'refreshToken',
      'api_secret',
      'privateKey',
      'mfa_secret',
    ]) {
      expect(isForbiddenField(field), field).toBe(true);
    }
  });

  it('lets an ordinary column through', () => {
    for (const field of ['reference', 'amountMinorUnits', 'createdAt', 'merchantRef', 'status']) {
      expect(isForbiddenField(field), field).toBe(false);
    }
  });

  it('over-matches rather than under-matches', () => {
    // A column called `token_bucket_refill` is not a credential, and refusing it costs a named
    // exception reviewed by a person. The other direction costs a refresh token in a CSV.
    expect(isForbiddenField('token_bucket_refill')).toBe(true);
  });

  it('reports every forbidden field in a set', () => {
    expect(forbiddenFields(['reference', 'passwordHash', 'status', 'apiKey'])).toEqual([
      'passwordHash',
      'apiKey',
    ]);
  });

  it('covers the categories section 9 forbids', () => {
    for (const required of [
      'password',
      'token',
      'apikey',
      'privatekey',
      'encryptionkey',
      'credential',
    ]) {
      expect(FORBIDDEN_FIELD_PATTERNS).toContain(required);
    }
  });
});

describe('the internal application schema', () => {
  it('has no field for a query, an expression or a script', () => {
    // A definition that could carry SQL would carry SQL into production through a review that
    // was looking at page layout. The schema is strict, so smuggling one in is a parse failure
    // rather than an ignored field — which is what makes the absence a control.
    const app = CONSOLE_TEMPLATES[0]!.build();

    for (const forbidden of ['query', 'sql', 'script', 'expression', 'code']) {
      expect(
        () => parseInternalApplication({ ...app, [forbidden]: 'SELECT 1' }),
        forbidden,
      ).toThrow();
    }

    expect(() =>
      parseInternalApplication({
        ...app,
        dataSources: [{ ...app.dataSources[0], query: 'SELECT * FROM wallets' }],
      }),
    ).toThrow();
  });

  it('refuses a delete marked reversible', () => {
    expect(() => actionSchema.parse(anAction({ operation: 'delete', reversible: true }))).toThrow(
      /not reversible/,
    );
  });

  it('refuses an irreversible action with no reason', () => {
    expect(() =>
      actionSchema.parse(anAction({ reversible: false, requiresReason: false })),
    ).toThrow(/needs a reason/);
  });

  it('refuses an action whose path is not a gateway path', () => {
    expect(() => actionSchema.parse(anAction({ apiPath: '/wallets/freeze' }))).toThrow();
    expect(() =>
      actionSchema.parse(anAction({ apiPath: 'https://bank.example/freeze' })),
    ).toThrow();
  });

  it('refuses a traversal in an action path', () => {
    expect(() => actionSchema.parse(anAction({ apiPath: '/internal/v1/../admin' }))).toThrow(
      /".."/,
    );
  });

  it('refuses a component bound to a data source that does not exist', () => {
    const app = CONSOLE_TEMPLATES[0]!.build();

    expect(() =>
      parseInternalApplication({
        ...app,
        pages: [
          {
            ...app.pages[0]!,
            components: [
              {
                id: 'broken',
                kind: 'table',
                dataSourceId: 'nonexistent',
                actionIds: [],
                fields: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(/No data source/);
  });

  it('refuses a component offering an action that does not exist', () => {
    const app = CONSOLE_TEMPLATES[0]!.build();

    expect(() =>
      parseInternalApplication({
        ...app,
        pages: [
          {
            ...app.pages[0]!,
            components: [{ id: 'broken', kind: 'table', actionIds: ['nonexistent'], fields: [] }],
          },
        ],
      }),
    ).toThrow(/No action/);
  });

  it('refuses a highly-restricted production app that has never had a security review', () => {
    const app = CONSOLE_TEMPLATES.find(
      (template) => template.id === 'risk-compliance-console',
    )!.build();

    expect(() =>
      parseInternalApplication({ ...app, environment: 'prod', lastSecurityReview: null }),
    ).toThrow(/never had a security review/);
  });
});

describe('the console templates', () => {
  it('ships the ten phase-12 templates and the phase-13 governance console', () => {
    expect(CONSOLE_TEMPLATES.map((template) => template.id).sort()).toEqual([
      'ai-operations-console',
      'approval-workbench',
      'case-management',
      'customer-support-console',
      'enterprise-governance-console',
      'finance-console',
      'financial-product-studio',
      'generic-dashboard',
      'operations-console',
      'platform-admin-console',
      'risk-compliance-console',
    ]);
  });

  it('validates every one', () => {
    for (const template of CONSOLE_TEMPLATES) {
      expect(() => template.build(), template.id).not.toThrow();
    }
  });

  it('routes every action through the gateway', () => {
    // No console writes directly. Anywhere.
    for (const template of CONSOLE_TEMPLATES) {
      for (const action of template.build().actions) {
        expect(action.apiPath.startsWith('/internal/v1/'), `${template.id}:${action.id}`).toBe(
          true,
        );
      }
    }
  });

  it('exposes no forbidden field in any data source', () => {
    for (const template of CONSOLE_TEMPLATES) {
      for (const source of template.build().dataSources) {
        expect(
          forbiddenFields(source.fields, source.fieldExceptions),
          `${template.id}:${source.id}`,
        ).toEqual([]);
      }
    }
  });

  it('gives the Product Studio no way to publish', () => {
    // The Studio composes and submits; TrustOS approves and publishes. A publish button here
    // would be a way to reach production from a low-code console.
    const studio = findConsoleTemplate('financial-product-studio')!.build();
    const ids = studio.actions.map((action) => action.id);

    expect(ids).toContain('submit');
    expect(ids).not.toContain('publish');
    expect(ids).not.toContain('activate');
    expect(ids).not.toContain('rollback');
  });

  it('gives support no way to change a balance', () => {
    const support = findConsoleTemplate('customer-support-console')!.build();

    for (const action of support.actions) {
      // Support may *request* a freeze. Support may not freeze, credit or debit.
      expect(action.apiPath).not.toMatch(/\/(credit|debit|adjust)\b/);
    }

    expect(support.actions.map((action) => action.id)).toContain('request-freeze');
  });

  it('gives finance no way to post to the ledger', () => {
    const finance = findConsoleTemplate('finance-console')!.build();

    for (const action of finance.actions) {
      expect(action.apiPath).not.toMatch(/\/journals?\b/);
      expect(action.apiPath).not.toMatch(/\/postings?\b/);
    }

    // What replaces it: a request that runs maker-checker.
    const adjustment = finance.actions.find((action) => action.id === 'request-adjustment');
    expect(adjustment?.requiresApproval).toBe(true);
  });

  it('marks every irreversible action as needing a reason', () => {
    for (const template of CONSOLE_TEMPLATES) {
      for (const action of template.build().actions) {
        if (action.reversible) continue;
        expect(action.requiresReason, `${template.id}:${action.id}`).toBe(true);
      }
    }
  });

  it('reports which resources each console reaches', () => {
    const operations = findConsoleTemplate('operations-console')!.build();
    expect(resourcesUsedBy(operations)).toContain(STANDARD_RESOURCE_IDS.REPORTING_TRANSACTIONS);
    expect(resourcesUsedBy(operations)).toContain(STANDARD_RESOURCE_IDS.API_WORKFLOW);
  });
});

describe('permissions and roles', () => {
  it('separates every pair that must not sit in one role', () => {
    for (const [role, permissions] of Object.entries(GOVERNANCE_ROLES)) {
      expect(governanceSegregationViolations(permissions), role).toEqual([]);
    }
  });

  it('gives the auditor read everything and write nothing', () => {
    const auditor = GOVERNANCE_ROLES.auditor as string[];

    expect(auditor).toContain(GOVERNANCE_PERMISSIONS.APP_READ.key);
    // An auditor who can unmask is an auditor whose access is indistinguishable from an
    // investigator's, and the distinction is why both roles exist.
    expect(auditor).not.toContain(GOVERNANCE_PERMISSIONS.PII_REVEAL.key);
    expect(auditor.some((permission) => permission.includes('.approve'))).toBe(false);
    expect(auditor).not.toContain(GOVERNANCE_PERMISSIONS.EXPORT_REQUEST.key);
  });

  it('does not let the people who most need a reveal approve one', () => {
    const support = GOVERNANCE_ROLES.customer_support as string[];
    expect(support).toContain(GOVERNANCE_PERMISSIONS.PII_REVEAL.key);
    expect(support).not.toContain(GOVERNANCE_PERMISSIONS.PII_REVEAL_APPROVE.key);
  });

  it('ships ten internal roles', () => {
    expect(Object.keys(GOVERNANCE_ROLES)).toHaveLength(10);
  });
});

describe('reviewed field exceptions', () => {
  it('lets a named exception through and nothing else', () => {
    expect(forbiddenFields(['inputTokens', 'passwordHash'], ['inputTokens'])).toEqual([
      'passwordHash',
    ]);
  });

  it('matches an exception on the normalized name, so spelling does not matter', () => {
    expect(forbiddenFields(['input_tokens'], ['inputTokens'])).toEqual([]);
  });

  it('has no wildcard', () => {
    // A wildcard is used once during an incident and never removed.
    expect(forbiddenFields(['passwordHash', 'apiKey'], ['*'])).toEqual(['passwordHash', 'apiKey']);
  });
});

describe('the enterprise governance console', () => {
  const app = enterpriseGovernanceConsole();

  it('reads nothing from a reporting replica', () => {
    /*
     * The other consoles mix Class A reporting reads with Class B authoritative calls, which is
     * right for them — a transaction list is a report. A policy version is not: reading it from a
     * replica means reading a rule from a surface where nothing checks whether the version found
     * is the one in force.
     */
    for (const dataSource of app.dataSources) {
      expect(dataSource.resourceId.startsWith('trustos.'), dataSource.id).toBe(true);
      expect(dataSource.resourceId.startsWith('reporting.'), dataSource.id).toBe(false);
    }
  });

  it('names every consequential action as a request', () => {
    /*
     * The verbs are deliberate. Each action calls an API that applies the segregation the
     * framework requires, so a console user holding the proposing permission cannot complete the
     * approval by clicking a second button — and naming them `approve-*` would misdescribe what
     * the console can do.
     */
    const consequential = app.actions.filter((action) => action.requiresApproval);

    expect(consequential.length).toBeGreaterThan(0);
    for (const action of consequential) {
      expect(action.id, action.id).toMatch(/^(propose|request)-/);
    }
  });

  it('has no action that approves anything', () => {
    for (const action of app.actions) {
      expect(action.id).not.toMatch(/^(approve|activate|apply|publish)-/);
    }
  });

  it('routes every action through a gateway path', () => {
    // No console writes directly, anywhere. This one least of all: its writes change what the
    // platform permits.
    for (const action of app.actions) {
      expect(action.apiPath.startsWith('/internal/v1/'), action.id).toBe(true);
    }
  });

  it('covers the five sections the specification names', () => {
    expect(app.pages.map((page) => page.id)).toEqual([
      'data-governance',
      'policies',
      'sre',
      'apis',
      'continuity',
    ]);
  });

  it('is restricted and high risk', () => {
    // It shows the classification of every table in the estate and the health of every service.
    expect(app.dataClassification).toBe('restricted');
    expect(app.riskClassification).toBe('high');
  });
});

describe('the console seed invents no governance facts', () => {
  it('records no security review date for any environment', () => {
    for (const env of ['dev', 'uat', 'prod'] as const) {
      for (const app of consoleCatalogFor(env).list(env)) {
        expect(app.lastSecurityReview).toBeNull();
      }
    }
  });

  it('withholds a production console whose classification demands a review', () => {
    const withheld = templatesWithheldFrom('prod');

    expect(withheld.length).toBeGreaterThan(0);
    // The classification is the reason, so every withheld one must carry it.
    for (const appId of withheld) {
      const template = CONSOLE_TEMPLATES.find((entry) => entry.build().appId === appId);
      expect(template?.build().dataClassification).toBe('highly_restricted');
    }
  });

  it('withholds nothing below production', () => {
    expect(templatesWithheldFrom('dev')).toEqual([]);
    expect(templatesWithheldFrom('uat')).toEqual([]);
  });

  it('does not serve a withheld console — an unregistered application does not exist', () => {
    const catalog = consoleCatalogFor('prod');

    for (const appId of templatesWithheldFrom('prod')) {
      expect(catalog.find('prod', appId)).toBeUndefined();
      expect(() => catalog.require('prod', appId)).toThrow();
    }
  });

  it('still registers every console that needs no review', () => {
    const withheld = new Set(templatesWithheldFrom('prod'));
    const registered = consoleCatalogFor('prod')
      .list('prod')
      .map((app) => app.appId);

    for (const template of CONSOLE_TEMPLATES) {
      const appId = template.build().appId;
      if (withheld.has(appId)) continue;
      expect(registered).toContain(appId);
    }
  });
});
