import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCapturingOutput } from '../output';
import {
  runApiCatalog,
  runApiCompatibility,
  runBackupVerify,
  runDataCatalog,
  runDataClassify,
  runDataLineage,
  runDrValidate,
  runEnterpriseDoctor,
  runPolicySimulate,
  runPolicyValidate,
  runSreServices,
} from './enterprise';

/**
 * The commands are read-only, so the tests are too: everything here writes a fixture to a
 * temporary directory and asserts on the exit code and the lines printed.
 *
 * The exit code carries meaning and is asserted deliberately. These commands run in CI, and a
 * command that printed a finding and exited zero would be a command that passes a pipeline while
 * reporting a problem.
 */

async function fixture(name: string, contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trustos-enterprise-'));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(contents, null, 2), 'utf8');
  return path;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    entryId: 'db.merchant',
    kind: 'table',
    technicalName: 'merchants',
    businessName: 'Merchant records',
    description: 'Registered merchants, their status and their contact details.',
    parentId: null,
    owner: 'usr_merchant_ops',
    steward: 'usr_data_gov',
    businessDomain: 'merchant',
    classification: 'CONFIDENTIAL',
    personalData: true,
    environment: 'prod',
    residencyRegion: 'eu-west',
    purpose: 'Operating merchant accounts and answering support enquiries.',
    legalBasis: 'Contract',
    lastReviewDate: '2026-01-01T00:00:00.000Z',
    nextReviewDate: '2026-12-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('trustos data classify', () => {
  it('prints what a level obliges rather than what it is called', () => {
    /*
     * A classification that is only a label is a label somebody argues about. What a reviewer
     * needs is the obligations, and they are what this prints.
     */
    const output = createCapturingOutput();
    expect(runDataClassify('RESTRICTED', {}, output)).toBe(0);

    const text = output.lines.join('\n');
    expect(text).toContain('Reveal needs approval');
    expect(text).toContain('Default retention');
  });

  it('refuses a level that does not exist', () => {
    const output = createCapturingOutput();
    expect(runDataClassify('SECRET', {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('is not a classification level');
  });
});

describe('trustos data catalog', () => {
  it('lists the catalog', async () => {
    const output = createCapturingOutput();
    const path = await fixture('catalog.json', [entry()]);

    expect(await runDataCatalog(path, {}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('db.merchant');
  });

  it('exits non-zero when a table is classified below its columns', async () => {
    /*
     * A table classified INTERNAL whose columns are RESTRICTED is a restricted table with an
     * internal label, and nothing about the table entry says so. Exiting zero here would let it
     * through a pipeline.
     */
    const output = createCapturingOutput();
    const path = await fixture('catalog.json', [
      entry({ classification: 'INTERNAL' }),
      entry({
        entryId: 'db.merchant.tax_id',
        kind: 'column',
        parentId: 'db.merchant',
        technicalName: 'tax_id',
        businessName: 'Merchant tax identifier',
        classification: 'RESTRICTED',
      }),
    ]);

    expect(await runDataCatalog(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('classified below what their contents imply');
  });

  it('refuses YAML', async () => {
    // A YAML parser reachable from a file path is a deserialization surface, and the two most
    // widely used ones have both had vulnerabilities.
    const output = createCapturingOutput();
    const path = await fixture('catalog.yaml', [entry()]);

    expect(await runDataCatalog(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('JSON only');
  });

  it('reports a file that is not valid JSON without a stack trace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trustos-enterprise-'));
    const path = join(dir, 'catalog.json');
    await writeFile(path, '{ not json', 'utf8');

    const output = createCapturingOutput();
    expect(await runDataCatalog(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('not valid JSON');
  });
});

describe('trustos data lineage', () => {
  it('finds a report classified below what feeds it', async () => {
    /*
     * The finding worth having: a PUBLIC report fed by a RESTRICTED table is a restricted extract
     * with a public label, and the report entry reads perfectly reasonably on its own.
     */
    const catalog = await fixture('catalog.json', [
      entry({ classification: 'RESTRICTED' }),
      entry({
        entryId: 'report.merchants',
        kind: 'report',
        technicalName: 'merchant_summary',
        businessName: 'Merchant summary report',
        classification: 'PUBLIC',
        personalData: false,
      }),
    ]);

    const lineage = await fixture('lineage.json', [
      {
        fromEntryId: 'db.merchant',
        toEntryId: 'report.merchants',
        relation: 'rendered_in_report',
        description: 'The merchant report selects directly from the merchant table.',
        source: 'declared',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const output = createCapturingOutput();
    expect(await runDataLineage(catalog, lineage, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('classified below what feeds them');
  });
});

function policy(overrides: Record<string, unknown> = {}) {
  return {
    policyId: 'api.quota',
    name: 'API quota',
    description: 'Decides whether a consumer may make another call today against their allowance.',
    category: 'api',
    version: '1.0.0',
    owner: 'usr_platform',
    status: 'active',
    rules: [
      {
        ruleId: 'deny-over-quota',
        description: 'Over the daily quota, calls are refused.',
        priority: 10,
        when: { field: 'callsToday', operator: 'gt', value: 10_000 },
        effect: 'deny',
        reason: 'The daily quota for this plan has been reached.',
      },
      {
        ruleId: 'allow-within-quota',
        description: 'Within the quota, calls proceed.',
        priority: 20,
        when: { field: 'callsToday', operator: 'lte', value: 10_000 },
        effect: 'allow',
        reason: 'Within the daily quota.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      { name: 'over the quota', attributes: { callsToday: 20_000 }, expect: 'deny' },
      { name: 'within the quota', attributes: { callsToday: 5 }, expect: 'allow' },
    ],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('trustos policy', () => {
  it('passes a policy that does what it says', async () => {
    const output = createCapturingOutput();
    const path = await fixture('policies.json', [policy()]);

    expect(await runPolicyValidate(path, {}, output)).toBe(0);
  });

  it('fails a policy whose own tests do not pass', async () => {
    const output = createCapturingOutput();
    const path = await fixture('policies.json', [
      policy({
        testCases: [
          {
            name: 'a call within the quota, expected to be refused',
            attributes: { callsToday: 5 },
            expect: 'deny',
          },
          {
            name: 'a call over the quota, expected to be permitted',
            attributes: { callsToday: 20_000 },
            expect: 'allow',
          },
        ],
      }),
    ]);

    expect(await runPolicyValidate(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('expected deny, got ALLOW');
  });

  it('simulates a draft, and says that it enforced nothing', async () => {
    /*
     * Simulating an unapproved policy is the entire point of simulating, and it is safe here
     * precisely because the CLI cannot enforce anything.
     */
    const output = createCapturingOutput();
    const path = await fixture('policies.json', [policy({ status: 'draft' })]);

    expect(await runPolicySimulate(path, '{"callsToday":5}', {}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('enforces nothing');
  });

  it('exits 2 on a denial, distinctly from an error', async () => {
    // A pipeline needs to tell "the policy said no" from "the file was unreadable".
    const output = createCapturingOutput();
    const path = await fixture('policies.json', [policy()]);

    expect(await runPolicySimulate(path, '{"callsToday":50000}', {}, output)).toBe(2);
  });

  it('names attributes the policy reads that were not supplied', async () => {
    // A rule reading a missing attribute never fires, which looks like a rule that never needed to.
    const output = createCapturingOutput();
    const path = await fixture('policies.json', [policy()]);

    await runPolicySimulate(path, '{}', {}, output);
    expect(output.lines.join('\n')).toContain('never fires');
  });
});

describe('trustos sre services', () => {
  it('reports a tier inversion and exits non-zero', async () => {
    /*
     * A tier-1 service critically depending on a tier-3 one has an availability ceiling below its
     * own objective. Each service reads reasonably alone.
     */
    const path = await fixture('services.json', {
      runbooks: [
        {
          runbookId: 'rb.outage',
          title: 'Service outage',
          trigger: 'The service reports unavailable for more than two minutes.',
          severityHint: 'SEV1',
          steps: [
            { title: 'Confirm', action: 'Check readiness on every instance.', verification: null },
          ],
          escalateTo: 'Platform on-call.',
          lastReviewedAt: '2026-05-01T00:00:00.000Z',
          ownerId: 'usr_platform',
        },
      ],
      services: [
        {
          serviceId: 'payments.api',
          name: 'Payments API',
          description: 'Accepts payment requests and posts them to the ledger.',
          tier: 'tier_1',
          ownerTeam: 'payments',
          onCallRotation: 'payments-primary',
          runbookIds: ['rb.outage'],
          environment: 'production',
          registeredAt: '2026-01-01T00:00:00.000Z',
          dependencies: [
            {
              dependencyId: 'reporting',
              kind: 'api',
              description: 'Reads the nightly reporting extract during settlement.',
              critical: true,
              targetServiceId: 'reporting.batch',
              degradedBehaviour: 'Settlement is deferred.',
              runbookId: 'rb.outage',
            },
          ],
        },
        {
          serviceId: 'reporting.batch',
          name: 'Reporting batch',
          description: 'Builds the nightly reporting extract.',
          tier: 'tier_3',
          ownerTeam: 'data',
          onCallRotation: null,
          runbookIds: [],
          environment: 'production',
          registeredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const output = createCapturingOutput();
    expect(await runSreServices(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('cannot exceed its dependency');
  });
});

function api(overrides: Record<string, unknown> = {}) {
  return {
    apiId: 'merchant.api',
    name: 'Merchant API',
    description: 'Registration, verification and profile management for merchants.',
    version: '1.0.0',
    domain: 'merchant',
    environment: 'production',
    lifecycle: 'PUBLISHED',
    businessOwnerId: 'usr_business',
    technicalOwnerId: 'usr_tech',
    authentication: 'api_key',
    scopes: ['merchants:read'],
    operations: [
      {
        operationId: 'listMerchants',
        method: 'GET',
        path: '/api/merchants',
        summary: 'Lists the merchants in the calling organization.',
        scopes: ['merchants:read'],
        classification: 'CONFIDENTIAL',
        idempotent: true,
      },
    ],
    openApiRef: 'specs/merchant-api.yaml',
    serviceId: 'merchant.api',
    sloId: 'merchant.api.availability',
    approvedBy: 'usr_governance',
    approvedAt: '2026-02-01T00:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('trustos api', () => {
  it('reports an API live in production with no recorded approval', async () => {
    const output = createCapturingOutput();
    const path = await fixture('apis.json', [api({ approvedBy: null, approvedAt: null })]);

    expect(await runApiCatalog(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('no recorded governance approval');
  });

  it('catches a breaking change shipped as a patch', async () => {
    /*
     * The check the command exists for. A moved path released as 1.0.1 is exactly the silent break
     * the specification names, and it reads as harmless in a diff.
     */
    const from = await fixture('from.json', api());
    const to = await fixture(
      'to.json',
      api({
        version: '1.0.1',
        operations: [
          {
            operationId: 'listMerchants',
            method: 'GET',
            path: '/api/v2/merchants',
            summary: 'Lists the merchants in the calling organization.',
            scopes: ['merchants:read'],
            classification: 'CONFIDENTIAL',
            idempotent: true,
          },
        ],
      }),
    );

    const output = createCapturingOutput();
    expect(await runApiCompatibility(from, to, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('require a major version');
  });

  it('accepts the same change as a major', async () => {
    const from = await fixture('from.json', api());
    const to = await fixture(
      'to.json',
      api({
        version: '2.0.0',
        operations: [
          {
            operationId: 'listMerchants',
            method: 'GET',
            path: '/api/v2/merchants',
            summary: 'Lists the merchants in the calling organization.',
            scopes: ['merchants:read'],
            classification: 'CONFIDENTIAL',
            idempotent: true,
          },
        ],
      }),
    );

    const output = createCapturingOutput();
    expect(await runApiCompatibility(from, to, {}, output)).toBe(0);
  });
});

function backup(overrides: Record<string, unknown> = {}) {
  return {
    backupId: 'bk_pg_20260601',
    source: 'postgresql',
    scope: 'trustos_production',
    environment: 'production',
    startedAt: '2026-06-01T02:00:00.000Z',
    completedAt: '2026-06-01T02:14:00.000Z',
    location: 's3://trustos-backups-eu/postgres/2026-06-01.dump',
    sameFailureDomain: false,
    encrypted: true,
    encryptionMethod: 'AES-256-GCM, key held in the platform KMS.',
    classification: 'HIGHLY_RESTRICTED',
    retentionDays: 3650,
    checksum: 'sha256:9f2c4a1b7e33',
    checksumVerifiedAt: '2026-06-01T02:20:00.000Z',
    verifiedAt: '2026-06-01T02:30:00.000Z',
    verificationNotes: 'Row counts match the source within the replication window.',
    ...overrides,
  };
}

describe('trustos backup verify', () => {
  it('says plainly that it restored nothing', async () => {
    /*
     * The command does not verify a backup — it reports what has been verified. Verifying means
     * reading it back and restoring it, which needs the backup, a target and the time.
     */
    const output = createCapturingOutput();
    const path = await fixture('backups.json', [backup()]);

    await runBackupVerify(path, {}, output);
    expect(output.lines.join('\n')).toContain('restores nothing');
  });

  it('exits non-zero for a backup nobody has restored from', async () => {
    const output = createCapturingOutput();
    const path = await fixture('backups.json', [backup()]);

    expect(await runBackupVerify(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('hypothesis');
  });

  it('passes one that has been restored from', async () => {
    const output = createCapturingOutput();
    const path = await fixture('backups.json', [
      backup({ lastRestoreTestAt: '2026-05-15T02:47:00.000Z', lastRestoreTestId: 'rt_20260515' }),
    ]);

    expect(await runBackupVerify(path, {}, output)).toBe(0);
  });
});

describe('trustos enterprise doctor', () => {
  it('does not count a check it could not run as one that passed', async () => {
    /*
     * The whole value of the command. "6 checks passed" over a directory with one file is a
     * sentence that ends up in a readiness report, and it is not true.
     */
    const catalog = await fixture('catalog.json', [entry()]);
    const output = createCapturingOutput();

    await runEnterpriseDoctor({ catalog }, {}, output);
    const text = output.lines.join('\n');

    expect(text).toContain('A check that did not run is not a check that passed');
    expect(text).toContain('skipped');
  });

  it('fails when nothing at all was supplied', async () => {
    const output = createCapturingOutput();
    expect(await runEnterpriseDoctor({}, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('Nothing was checked');
  });

  it('fails when a supplied document has a blocking finding', async () => {
    const catalog = await fixture('catalog.json', [
      entry({ classification: 'INTERNAL' }),
      entry({
        entryId: 'db.merchant.tax_id',
        kind: 'column',
        parentId: 'db.merchant',
        technicalName: 'tax_id',
        businessName: 'Merchant tax identifier',
        classification: 'RESTRICTED',
      }),
    ]);

    const output = createCapturingOutput();
    expect(await runEnterpriseDoctor({ catalog }, {}, output)).toBe(1);
  });

  it('skips lineage when there is no catalog to check it against', async () => {
    // Lineage findings are derived by comparing edges to classifications; the edges alone say
    // nothing, and reporting a pass over them would be reporting a pass over an empty check.
    const lineage = await fixture('lineage.json', []);
    const output = createCapturingOutput();

    await runEnterpriseDoctor({ lineage }, {}, output);
    expect(output.lines.join('\n')).toContain('No lineage supplied');
  });
});

describe('trustos dr validate', () => {
  it('refuses to call a tabletop a tested plan', async () => {
    const path = await fixture('dr.json', [
      {
        planId: 'dr.region-failure',
        scenario: 'region_failure',
        title: 'Primary region unavailable',
        trigger: 'Every instance in the primary region fails readiness for more than ten minutes.',
        serviceIds: ['payments.api'],
        ownerId: 'usr_platform',
        decisionAuthority: 'Head of Platform',
        deputyAuthority: 'On-call platform lead',
        procedure: [
          {
            title: 'Confirm the region is unavailable',
            action: 'Probe from a second region before failing over.',
            verification: 'Two independent probes agree.',
            performedBy: 'Platform on-call',
          },
        ],
        dataDecision:
          'Fail over at the standby last confirmed replication position; later writes replay.',
        communication: {
          audiences: ['Merchants with active integrations'],
          channels: ['Status page hosted outside the primary region'],
          spokespersonRole: 'Head of Platform',
          cadenceMinutes: 30,
        },
        validation: ['A synthetic payment completes end to end against the recovered region.'],
        failback: {
          procedure: 'Resynchronize from the secondary, verify balance, and cut back in a window.',
          dataReconciliation: 'Writes during failover replay into the primary and reconcile.',
          decisionAuthority: 'Head of Platform with the finance controller',
        },
        rtoMinutes: 60,
        rpoMinutes: 5,
        lastReviewedAt: '2026-04-15T00:00:00.000Z',
        exercises: [
          {
            exerciseId: 'ex_1',
            performedAt: '2026-04-01T00:00:00.000Z',
            kind: 'tabletop',
            succeeded: true,
            findings: [],
          },
        ],
      },
    ]);

    const output = createCapturingOutput();
    expect(await runDrValidate(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('read, not run');
  });
});
