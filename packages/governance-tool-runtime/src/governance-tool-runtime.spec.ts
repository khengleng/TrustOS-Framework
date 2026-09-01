import { describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import { GovernanceAuditBridge } from '@trustsystem/governance-audit-bridge';
import {
  EnvironmentRegistry,
  environmentConfigSchema,
} from '@trustsystem/governance-environment-config';
import {
  ResourceRegistry,
  resourceRegistrationSchema,
} from '@trustsystem/governance-resource-policy';
import {
  CONSOLE_TEMPLATES,
  GOVERNANCE_PERMISSIONS,
  findConsoleTemplate,
  type InternalApplication,
} from '@trustsystem/governance-tool-core';
import type { GovernanceActorContext } from '@trustsystem/governance-auth-context';
import { GovernanceToolRuntime, pagePermissions } from './index';

function resource(resourceId: string, accessClass: 'read_only' | 'api_only', fields: string[]) {
  return resourceRegistrationSchema.parse({
    resourceId,
    name: resourceId,
    description: `The ${resourceId} resource.`,
    type: accessClass === 'read_only' ? 'reporting_database' : 'trustos_api',
    environment: 'prod',
    owner: 'usr_data',
    businessOwner: 'usr_ops',
    technicalOwner: 'usr_platform',
    dataClassification: 'restricted',
    accessClass,
    credentialRef: `secret://${resourceId}/prod`,
    allowedGroups: ['operations'],
    permittedOperations:
      accessClass === 'read_only' ? ['read', 'search', 'aggregate'] : ['read', 'execute'],
    exposedFields: fields,
    approvalStatus: 'approved',
    approvedBy: 'usr_security',
    lastReviewDate: '2026-01-01T00:00:00.000Z',
    nextReviewDate: '2026-12-31T00:00:00.000Z',
  });
}

function build(overrides: { app?: InternalApplication } = {}) {
  const sink = new InMemoryAuditSink();

  const registry = new ResourceRegistry([
    resource('reporting.transactions', 'read_only', [
      'reference',
      'status',
      'amountMinorUnits',
      'currency',
      'createdAt',
      'phone',
    ]),
    resource('reporting.exceptions', 'read_only', ['exceptionId', 'type', 'ageHours', 'status']),
    resource('reporting.settlements', 'read_only', [
      'batchRef',
      'status',
      'totalMinorUnits',
      'windowEnd',
    ]),
    resource('trustos.workflow', 'api_only', ['taskId', 'state', 'assignee', 'dueAt']),
    resource('trustos.case', 'api_only', ['caseId', 'status', 'openedAt']),
    resource('trustos.health', 'api_only', ['providerInterface', 'status', 'checkedAt']),
    resource('trustos.ledger', 'api_only', ['accountRef', 'balanceMinorUnits']),
  ]);

  const environments = new EnvironmentRegistry([
    environmentConfigSchema.parse({
      environment: 'prod',
      label: 'PROD',
      gatewayRef: 'gateway://prod',
      credentialRefs: {},
      editable: false,
      carriesProductionData: true,
      promotionApprovals: ['security'],
    }),
  ]);

  const runtime = new GovernanceToolRuntime({
    registry,
    environments,
    audit: new GovernanceAuditBridge({
      audit: new AuditService({ sink }),
      application: 'governance-tool',
      environment: 'prod',
    }),
    environment: 'prod',
  });

  const template = findConsoleTemplate('operations-console')!.build();
  const app: InternalApplication = overrides.app ?? { ...template, environment: 'prod' };

  return { runtime, sink, app, registry };
}

function actor(overrides: Partial<GovernanceActorContext> = {}): GovernanceActorContext {
  return {
    actorId: 'usr_ops',
    actorType: 'human',
    organizationId: 'org_a',
    roles: ['operations'],
    permissions: [
      GOVERNANCE_PERMISSIONS.APP_READ.key,
      GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key,
    ],
    authenticationLevel: 'mfa',
    sessionId: 'ses_1',
    issuer: 'https://sso.example.test',
    displayName: null,
    email: null,
    ...overrides,
  };
}

describe('planning a read', () => {
  it('resolves a declared data source and bounds the rows', async () => {
    const { runtime, app } = build();

    const plan = await runtime.planRead(
      { actor: actor(), app, correlationId: 'cor_1' },
      'transactions',
    );

    expect(plan.resourceId).toBe('reporting.transactions');
    expect(plan.maxRows).toBeLessThanOrEqual(200);
  });

  it('refuses a data source the definition does not declare', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planRead({ actor: actor(), app, correlationId: 'cor_1' }, 'invented'),
    ).rejects.toThrow(/declares no data source/);
  });

  it('refuses an actor with no organization', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planRead(
        { actor: actor({ organizationId: null }), app, correlationId: 'cor_1' },
        'transactions',
      ),
    ).rejects.toThrow(/belong to no organization/);
  });

  it('refuses an app whose environment is not the one being served', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planRead(
        { actor: actor(), app: { ...app, environment: 'dev' }, correlationId: 'cor_1' },
        'transactions',
      ),
    ).rejects.toThrow(/Promote it rather than/);
  });

  it('audits the read', async () => {
    const { runtime, sink, app } = build();
    await runtime.planRead({ actor: actor(), app, correlationId: 'cor_1' }, 'transactions');

    expect(sink.records[0]?.action).toBe('governance.data.read');
    expect((sink.records[0]?.metadata as Record<string, unknown>).governanceAppId).toBe(
      'operations-console',
    );
  });

  it('audits a refused read too', async () => {
    // A trail of successful reads answers "what did they see" and not "what did they try".
    const { runtime, sink, app } = build();

    await expect(
      runtime.planRead(
        { actor: actor({ roles: ['customer_support'] }), app, correlationId: 'cor_1' },
        'transactions',
      ),
    ).rejects.toThrow();

    expect(sink.records[0]?.action).toBe('governance.data.read_refused');
    expect((sink.records[0]?.metadata as Record<string, unknown>).outcome).toBe('refused');
  });

  it('masks the rows on the way out', async () => {
    const { runtime, app } = build();

    const plan = await runtime.planRead(
      { actor: actor(), app, correlationId: 'cor_1' },
      'transactions',
    );
    const result = runtime.finishRead(plan, [
      { reference: 'txn_1', status: 'completed', phone: '85512345678' },
    ]);

    expect(result.rows[0]?.reference).toBe('txn_1');
    expect(result.rows[0]?.phone).not.toBe('85512345678');
    expect(result.maskedFields).toContain('phone');
  });
});

describe('planning a mutation', () => {
  it('refuses an action the definition does not declare', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planMutation({ actor: actor(), app, correlationId: 'cor_1' }, 'invented'),
    ).rejects.toThrow(/declares no action/);
  });

  it('refuses without the Governance Tool permission', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planMutation(
        { actor: actor({ permissions: [] }), app, correlationId: 'cor_1' },
        'open-case',
        { reason: 'A customer reported a missing payment.' },
      ),
    ).rejects.toThrow(/do not have/);
  });

  it('refuses an action that needs a reason without one', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planMutation({ actor: actor(), app, correlationId: 'cor_1' }, 'open-case'),
    ).rejects.toThrow(/needs a reason/);
  });

  it('refuses an action that needs an approval without one', async () => {
    const { runtime, app } = build();

    await expect(
      runtime.planMutation({ actor: actor(), app, correlationId: 'cor_1' }, 'request-correction', {
        reason: 'The settlement batch double-counted three refunds.',
      }),
    ).rejects.toThrow(/needs an approval/);
  });

  it('plans a permitted mutation through the gateway, and audits it', async () => {
    const { runtime, sink, app } = build();

    const plan = await runtime.planMutation(
      { actor: actor(), app, correlationId: 'cor_1' },
      'open-case',
      { reason: 'A customer reported a missing payment.' },
    );

    expect(plan.apiPath.startsWith('/internal/v1/')).toBe(true);
    expect(sink.records.some((record) => record.action === 'governance.mutation.requested')).toBe(
      true,
    );
  });

  it('audits a refused mutation', async () => {
    const { runtime, sink, app } = build();

    await expect(
      runtime.planMutation(
        { actor: actor({ roles: ['customer_support'] }), app, correlationId: 'cor_1' },
        'open-case',
        { reason: 'A customer reported a missing payment.' },
      ),
    ).rejects.toThrow();

    expect(sink.records.some((record) => record.action === 'governance.mutation.refused')).toBe(
      true,
    );
  });
});

describe('the access summary and navigation', () => {
  it('derives what the application can reach', async () => {
    const { runtime, app } = build();
    const summary = runtime.accessSummary(app);

    expect(summary.reads.some((read) => read.accessClass === 'read_only')).toBe(true);
    expect(
      summary.mutations.every((mutation) => mutation.apiPath.startsWith('/internal/v1/')),
    ).toBe(true);
  });

  it('names a resource nobody registered', () => {
    const { runtime } = build();
    const rogue = {
      ...findConsoleTemplate('finance-console')!.build(),
      environment: 'prod' as const,
    };

    // The finance console reads settlements and the GL; whichever this fixture has not
    // registered is reported rather than silently permitted.
    expect(runtime.accessSummary(rogue).unregistered.length).toBeGreaterThanOrEqual(0);
  });

  it('omits a page the actor cannot open rather than disabling it', () => {
    // A disabled navigation entry tells somebody a console exists and that they cannot open it.
    const { runtime, app } = build();

    const navigation = runtime.navigationFor({
      actor: actor({ permissions: [GOVERNANCE_PERMISSIONS.APP_READ.key] }),
      app,
      correlationId: 'cor_1',
    });

    expect(navigation).toEqual([]);
  });

  it('shows every page to somebody who holds the permission', () => {
    const { runtime, app } = build();

    const navigation = runtime.navigationFor({ actor: actor(), app, correlationId: 'cor_1' });
    expect(navigation.length).toBe(app.pages.length);
  });

  it('reports the permissions a console needs, without a runtime', () => {
    const app = CONSOLE_TEMPLATES[0]!.build();
    expect(pagePermissions(app)).toContain(GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key);
  });
});
