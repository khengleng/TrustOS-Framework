import { describe, expect, it } from 'vitest';
import { MaskPolicy } from '@trustos/governance-pii-policy';
import {
  DEFAULT_EXPORT_POLICIES,
  applyExportPolicy,
  assertExportAllowed,
  evaluateExport,
  exportAuditDetail,
  exportPolicySchema,
  watermarkFor,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'exp_1',
    appId: 'finance-console',
    actorId: 'usr_finance',
    organizationId: 'org_a',
    resourceId: 'reporting.settlements',
    classification: 'confidential' as const,
    fields: ['batchRef', 'totalMinorUnits', 'currency'],
    estimatedRows: 100,
    justification: 'Month-end reconciliation against the counterparty statement for May.',
    requestedAt: NOW.toISOString(),
    ...overrides,
  };
}

function decide(
  overrides: Record<string, unknown> = {},
  policyOverrides: Record<string, unknown> = {},
) {
  const built = request(overrides);

  return evaluateExport({
    request: built as never,
    policy: { ...DEFAULT_EXPORT_POLICIES[built.classification], ...policyOverrides } as never,
    hasPermission: true,
    approved: false,
    now: NOW,
  });
}

describe('export policy', () => {
  it('allows a small, justified export', () => {
    expect(decide().allowed).toBe(true);
  });

  it('refuses an export above the ceiling for its classification', () => {
    const decision = decide({ estimatedRows: 1_000_000 });

    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]).toContain('filters removed');
  });

  it('descends the ceiling sharply with classification', () => {
    // A hundred thousand public rows is a report; a hundred thousand restricted rows is an
    // incident.
    expect(DEFAULT_EXPORT_POLICIES.public.maxRows).toBeGreaterThan(
      DEFAULT_EXPORT_POLICIES.internal.maxRows,
    );
    expect(DEFAULT_EXPORT_POLICIES.internal.maxRows).toBeGreaterThan(
      DEFAULT_EXPORT_POLICIES.confidential.maxRows,
    );
    expect(DEFAULT_EXPORT_POLICIES.confidential.maxRows).toBeGreaterThan(
      DEFAULT_EXPORT_POLICIES.restricted.maxRows,
    );
    expect(DEFAULT_EXPORT_POLICIES.restricted.maxRows).toBeGreaterThan(
      DEFAULT_EXPORT_POLICIES.highly_restricted.maxRows,
    );
  });

  it('always requires approval for a highly-restricted export', () => {
    expect(DEFAULT_EXPORT_POLICIES.highly_restricted.approvalAboveRows).toBe(1);
  });

  it('refuses a justification that says nothing', () => {
    const decision = decide({ justification: 'reporting' });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals.join(' ')).toContain('twenty characters');
  });

  it('refuses without the permission', () => {
    const decision = evaluateExport({
      request: request() as never,
      policy: DEFAULT_EXPORT_POLICIES.confidential,
      hasPermission: false,
      approved: false,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
  });

  it('needs a second person above the threshold, and is satisfied by one', () => {
    expect(decide({ estimatedRows: 20_000 }).allowed).toBe(false);

    const approved = evaluateExport({
      request: request({ estimatedRows: 20_000 }) as never,
      policy: DEFAULT_EXPORT_POLICIES.confidential,
      hasPermission: true,
      approved: true,
      now: NOW,
    });
    expect(approved.allowed).toBe(true);
  });

  it('reports every refusal rather than only the first', () => {
    const decision = decide({ justification: 'x', estimatedRows: 999_999 });
    expect(decision.refusals.length).toBeGreaterThan(1);
  });

  it('refuses a policy whose approval threshold is above its ceiling', () => {
    expect(() =>
      exportPolicySchema.parse({
        classification: 'internal',
        maxRows: 1000,
        approvalAboveRows: 5000,
        expiryHours: 24,
      }),
    ).toThrow(/no export ever needs approval/);
  });

  it('refuses a highly-restricted policy that unmasks', () => {
    expect(() =>
      exportPolicySchema.parse({
        classification: 'highly_restricted',
        maxRows: 100,
        approvalAboveRows: 1,
        maskFields: false,
        expiryHours: 4,
      }),
    ).toThrow(/bulk reveal with no reveal record/);
  });
});

describe('applying the policy to rows', () => {
  it('masks on the way out, so masking survives the file', () => {
    const decision = decide();
    const rows = applyExportPolicy(
      [{ batchRef: 'stb_1', phone: '85512345678' }],
      decision,
      new MaskPolicy(),
    );

    expect(rows[0]?.batchRef).toBe('stb_1');
    expect(rows[0]?.phone).not.toBe('85512345678');
  });

  it('truncates to the effective ceiling', () => {
    const decision = decide({ estimatedRows: 2 });
    const rows = applyExportPolicy(
      [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }],
      decision,
      new MaskPolicy(),
    );
    expect(rows).toHaveLength(2);
  });

  it('watermarks with the actor and the instant, and not with a name', () => {
    const watermark = watermarkFor(request() as never, NOW);

    expect(watermark).toContain('usr_finance');
    expect(watermark).toContain(NOW.toISOString());
    // A watermark is read by whoever found the file, and that is not necessarily somebody
    // entitled to the exporter's identity.
    expect(watermark).not.toContain('@');
  });

  it('throws on a refused export', () => {
    expect(() => assertExportAllowed(decide({ estimatedRows: 999_999 }))).toThrow(/Export refused/);
  });

  it('audits names and counts, never contents', () => {
    const detail = exportAuditDetail(request() as never, decide());

    expect(detail.fields).toBe('batchRef,totalMinorUnits,currency');
    expect(detail.rows).toBe(100);
    expect(detail.justification).toContain('Month-end');
  });
});
