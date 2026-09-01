#!/usr/bin/env node
/**
 * Adversarial validation — hostile input against the deployed runtime and the
 * Approval Workbench service.
 *
 *   BASE_URL=https://… DATABASE_URL=postgres://… npm run validate:security
 *
 * The functional suites ask whether a control works when used correctly. This asks what
 * happens when it is used incorrectly on purpose, and it is looking for three specific
 * failures rather than "does it break":
 *
 *   1. **Fails open** — hostile input producing success where refusal was correct.
 *   2. **Fails loudly** — a 500 and a stack trace where a 4xx was correct. An unhandled
 *      exception is a parser reached by input nobody expected, and the trace tells an
 *      attacker which one.
 *   3. **Fails informatively** — a refusal that discloses whether the thing existed.
 *
 * A refusal is a pass. A 500 is a failure even when nothing leaked, because the next
 * input like it might.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wantJson = process.argv.includes('--json');
const baseUrl = (process.env.BASE_URL ?? '').replace(/\/$/, '');

const results = [];

function record(name, pass, detail, severity = 'high') {
  results.push({ check: name, status: pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL', detail, severity });
}

async function probe(path, init = {}) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    return { status: 0, headers: null, body: '', error: error.message };
  }
}

/** Refusal, and nothing that looks like an unhandled exception. */
function refusedCleanly(response) {
  const refused = response.status === 401 || response.status === 403 || response.status === 404;
  const noCrash = response.status !== 500 && response.status !== 502 && response.status !== 0;
  const leaks = /at [A-Za-z]+\.[A-Za-z]+ \(|node_modules|\/app\/packages|Error:|prisma|PrismaClient|ECONNREFUSED/i;
  return { ok: refused && noCrash && !leaks.test(response.body), refused, noCrash, leaked: leaks.test(response.body) };
}

// --- deployed surface --------------------------------------------------------

const WORKBENCH_ROUTES = [
  ['GET', '/api/governance/approvals'],
  ['GET', '/api/governance/approvals/wfi_test'],
  ['POST', '/api/governance/approvals/wfi_test/decision'],
  ['POST', '/api/governance/approvals/wfi_test/comments'],
  ['POST', '/api/governance/approvals/tasks/task_test/reassign'],
];

async function deployedChecks() {
  if (!baseUrl) {
    record('deployed', null, 'NOT_REACHED — BASE_URL not set');
    return;
  }

  for (const [method, path] of WORKBENCH_ROUTES) {
    const response = await probe(path, {
      method,
      ...(method === 'POST'
        ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : {}),
    });
    const verdict = refusedCleanly(response);
    record(
      `anonymous ${method} ${path}`,
      verdict.ok,
      `${response.status}${verdict.leaked ? ' — LEAKED INTERNALS' : ''}`,
    );
  }

  // Hostile path segments. The identifier reaches a router, a validator and a store;
  // any of the three mishandling it shows up as a 500 rather than a refusal.
  const hostileIds = [
    ['path traversal', '../../../../etc/passwd'],
    ['encoded traversal', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['null byte', 'wfi_test%00.png'],
    ['sql shaped', "wfi'%20OR%20'1'%3D'1"],
    ['very long id', 'w'.repeat(6000)],
    ['unicode', '%F0%9F%92%A3%E2%80%AE'],
    ['crlf', 'wfi%0d%0aX-Injected:%20yes'],
  ];

  for (const [label, id] of hostileIds) {
    const response = await probe(`/api/governance/approvals/${id}`);
    const verdict = refusedCleanly(response);
    const injected = response.headers?.get('x-injected');
    record(
      `hostile identifier: ${label}`,
      verdict.ok && !injected,
      `${response.status}${injected ? ' — HEADER INJECTED' : ''}${verdict.leaked ? ' — LEAKED' : ''}`,
    );
  }

  // Malformed and oversized bodies.
  const bodies = [
    ['malformed json', '{not json'],
    ['deeply nested json', JSON.stringify(nest(200))],
    ['oversized body', JSON.stringify({ explanation: 'x'.repeat(2_000_000) })],
    ['prototype pollution', '{"__proto__":{"isSuperAdmin":true},"action":"approve"}'],
    ['array where object expected', '[1,2,3]'],
  ];

  for (const [label, body] of bodies) {
    const response = await probe('/api/governance/approvals/wfi_test/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    // Anonymous, so 401 is the right answer whatever the body is — what matters is that
    // parsing the body never produced a crash.
    const crashed = response.status >= 500 || response.status === 0;
    record(`hostile body: ${label}`, !crashed, `${response.status}`);
  }

  // Prototype pollution must not have taken hold on the running process.
  const after = await probe('/api/governance/approvals');
  record(
    'prototype pollution did not alter the running process',
    after.status === 401,
    `queue still refuses anonymously with ${after.status}`,
  );

  // Method and override tampering.
  const override = await probe('/api/governance/approvals', {
    method: 'GET',
    headers: { 'X-HTTP-Method-Override': 'DELETE' },
  });
  record('method override header is not honoured', override.status === 401, `${override.status}`);

  // Security headers must survive an error response, not only a healthy one.
  const errored = await probe('/api/governance/approvals');
  for (const header of ['strict-transport-security', 'x-content-type-options', 'content-security-policy']) {
    record(
      `error responses still carry ${header}`,
      Boolean(errored.headers?.get(header)),
      errored.headers?.get(header)?.slice(0, 40) ?? 'absent',
      'medium',
    );
  }

  // Version and stack disclosure.
  const banner = errored.headers?.get('x-powered-by');
  record('no framework banner', !banner, banner ?? 'absent', 'medium');

  // CORS from an unapproved origin, on a route that matters.
  const cors = await probe('/api/governance/approvals', {
    headers: { Origin: 'https://attacker.example' },
  });
  const allowed = cors.headers?.get('access-control-allow-origin');
  record(
    'CORS refuses an unapproved origin on an authenticated route',
    allowed !== '*' && allowed !== 'https://attacker.example',
    `Access-Control-Allow-Origin: ${allowed ?? 'absent'}`,
  );

  // An unknown route must not be distinguishable in a way that maps the API.
  const unknown = await probe('/api/governance/approvals-not-real');
  record(
    'an unknown route does not disclose internals',
    !/at |node_modules|prisma/i.test(unknown.body),
    `${unknown.status}`,
    'low',
  );
}

function nest(depth) {
  let value = { action: 'approve', expectedVersion: 1 };
  for (let i = 0; i < depth; i += 1) value = { nested: value };
  return value;
}

// --- service surface, against the real database ------------------------------

async function serviceChecks() {
  if (!process.env.DATABASE_URL) {
    record('service', null, 'NOT_REACHED — DATABASE_URL not set');
    return;
  }

  const { PrismaClient } = await import('@prisma/client');
  const { ApprovalWorkbenchService } = await import('@trustos/approval-workbench');
  const prisma = new PrismaClient();

  const suffix = randomUUID().slice(0, 8);
  const orgA = await prisma.organization.create({
    data: { name: `Sec A ${suffix}`, slug: `sec-a-${suffix}` },
  });
  const orgB = await prisma.organization.create({
    data: { name: `Sec B ${suffix}`, slug: `sec-b-${suffix}` },
  });

  try {
    // A workbench over stores that record what they were asked, so the assertions can be
    // about the query rather than about the answer.
    const asked = [];
    const workbench = new ApprovalWorkbenchService({
      tasks: {
        listAvailable: async (actor, page, pageSize) => {
          asked.push({ call: 'listAvailable', organizationId: actor.organizationId, page, pageSize });
          return { items: [], total: 0, page, pageSize };
        },
        listMine: async (actor, page, pageSize) => {
          asked.push({ call: 'listMine', organizationId: actor.organizationId, page, pageSize });
          return { items: [], total: 0, page, pageSize };
        },
        find: async () => { throw new Error('not used'); },
      },
      engine: {
        find: async (actor, id) => {
          asked.push({ call: 'find', organizationId: actor.organizationId, id });
          const error = new Error('The requested resource was not found.');
          error.code = 'not_found';
          throw error;
        },
        list: async (actor, query) => {
          asked.push({ call: 'list', organizationId: actor.organizationId, query });
          return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
        },
        available: async () => [],
        transition: async (actor, input) => {
          asked.push({ call: 'transition', organizationId: actor.organizationId, input });
          throw Object.assign(new Error('refused'), { code: 'forbidden' });
        },
      },
      decisions: { listForInstance: async () => [] },
      audit: { query: async () => ({ items: [], totalItems: 0 }) },
    });

    const actor = {
      userId: 'user_attacker',
      actorType: 'user',
      email: 'attacker@a.test',
      tokenId: 'tok',
      organizationId: orgA.id,
      roles: ['viewer'],
      permissions: [],
      isSuperAdmin: false,
      groupIds: [],
      authenticationLevel: 'low',
      mfa: false,
    };

    const rejects = async (fn) => {
      try {
        await fn();
        return false;
      } catch {
        return true;
      }
    };

    // Query inputs that try to widen the read.
    const hostileQueries = [
      ['organization override', { scope: 'available', organizationId: orgB.id }],
      ['actor override', { scope: 'available', userId: 'someone-else' }],
      ['prototype pollution', JSON.parse('{"scope":"available","__proto__":{"isSuperAdmin":true}}')],
      ['negative page', { scope: 'available', page: -1 }],
      ['zero page', { scope: 'available', page: 0 }],
      ['huge page size', { scope: 'available', pageSize: 1_000_000 }],
      ['NaN page', { scope: 'available', page: 'NaN' }],
      ['unknown scope', { scope: 'everything' }],
      ['unknown sort field', { scope: 'available', sortBy: 'organizationId' }],
    ];

    for (const [label, query] of hostileQueries) {
      const refused = await rejects(() => workbench.queue(actor, query));
      record(`query rejected: ${label}`, refused, refused ? 'refused by the schema' : 'ACCEPTED');
    }

    // A very long search string is accepted or refused, but must not reach the store
    // unbounded.
    const longSearch = await rejects(() => workbench.queue(actor, { scope: 'available', search: 'x'.repeat(5000) }));
    record('query rejected: oversized search', longSearch, longSearch ? 'refused by the schema' : 'ACCEPTED');

    /*
     * Whatever was accepted, the tenant asked for is always the actor's own.
     *
     * The first version of this check passed on zero recorded calls, because every
     * hostile query above had been refused by the schema — so it asserted nothing and
     * would have kept passing if the scoping were removed entirely. It now drives
     * legitimate queries first, so there is something to inspect, and fails if there is
     * not.
     */
    asked.length = 0;
    await workbench.queue(actor, { scope: 'available' });
    await workbench.queue(actor, { scope: 'mine' });
    await workbench.queue(actor, { scope: 'completed' });
    await workbench.detail(actor, 'wfi_probe').catch(() => undefined);

    const foreign = asked.filter((entry) => entry.organizationId !== orgA.id);
    record(
      'every store call carried the actor own tenant, and there were calls to inspect',
      asked.length >= 4 && foreign.length === 0,
      foreign.length
        ? `LEAKED to ${foreign.length} other tenant(s)`
        : `${asked.length} call(s) inspected, all scoped to the actor`,
    );

    // A forged super-admin flag must not turn a scoped read into an unscoped one.
    asked.length = 0;
    await workbench.queue({ ...actor, isSuperAdmin: true }, { scope: 'available' }).catch(() => undefined);
    const stillScoped = asked.every((entry) => entry.organizationId === orgA.id);
    record(
      'a forged super-admin flag does not widen the tenant scope',
      stillScoped,
      stillScoped ? 'still scoped to the actor organization' : 'SCOPE WIDENED',
    );

    // Decision submissions that try to carry authority.
    const hostileDecisions = [
      ['actor override', { action: 'approve', expectedVersion: 1, actorId: 'user_maker' }],
      ['organization override', { action: 'approve', expectedVersion: 1, organizationId: orgB.id }],
      ['role override', { action: 'approve', expectedVersion: 1, roles: ['admin'] }],
      ['superadmin override', { action: 'approve', expectedVersion: 1, isSuperAdmin: true }],
      ['undeclared action', { action: 'cancel', expectedVersion: 1 }],
      ['missing version', { action: 'approve' }],
      ['negative version', { action: 'approve', expectedVersion: -5 }],
      ['reject without reason', { action: 'reject', expectedVersion: 1 }],
      ['prototype pollution', JSON.parse('{"action":"approve","expectedVersion":1,"__proto__":{"x":1}}')],
    ];

    for (const [label, body] of hostileDecisions) {
      const refused = await rejects(() => workbench.decide(actor, 'wfi_x', body));
      record(`decision rejected: ${label}`, refused, refused ? 'refused' : 'ACCEPTED');
    }

    // An empty or whitespace tenant must be refused rather than querying nothing.
    for (const [label, organizationId] of [['empty', ''], ['whitespace', '   ']]) {
      const refused = await rejects(() => workbench.queue({ ...actor, organizationId }, { scope: 'available' }));
      record(`tenantless actor refused: ${label}`, refused, refused ? 'refused' : 'ACCEPTED');
    }

    // A cross-tenant read is not found, never forbidden — forbidden confirms existence.
    let code = null;
    try {
      await workbench.detail({ ...actor, organizationId: orgB.id }, 'wfi_belongs_to_a');
    } catch (error) {
      code = error.code ?? null;
    }
    record(
      'a cross-tenant read is not found, not forbidden',
      code === 'not_found',
      `refused as ${code ?? 'nothing'}`,
    );
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    await prisma.$disconnect();
  }
}

await deployedChecks();
await serviceChecks();

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: baseUrl || null,
  totals: { checks: results.length, passed, failed, skipped },
  verdict: failed === 0 ? (skipped > 0 ? 'PARTIAL' : 'PASS') : 'FAIL',
  results,
};

if (wantJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Adversarial validation${baseUrl ? ` — ${baseUrl}` : ''}\n`);
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)}  ${r.check.padEnd(60)} ${r.detail}`);
  }
  console.log(`\n  ${passed}/${results.length} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`\nVerdict: ${summary.verdict}`);
}

mkdirSync(join(root, 'docs/validation'), { recursive: true });
writeFileSync(join(root, 'docs/validation/security-latest.json'), `${JSON.stringify(summary, null, 2)}\n`);

process.exit(failed > 0 ? 1 : 0);
