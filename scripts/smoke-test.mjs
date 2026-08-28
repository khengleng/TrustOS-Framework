#!/usr/bin/env node
/**
 * Smoke tests against a deployed TrustOS API.
 *
 * Eleven checks, in the order the readiness specification asks for them. Each is an HTTP request
 * against a *running* service — that is the whole point, and it is why this is a script rather
 * than a vitest suite: the suite runs in-process and would prove nothing about a deployment.
 *
 * Run:
 *   TRUSTOS_BASE_URL=https://trustos-api-dev.up.railway.app node scripts/smoke-test.mjs
 *
 * Writes a machine-readable report to `smoke-report.json` and exits non-zero on any failure.
 *
 * **What a failure means.** Each check reports what it proved and what it could not. A check that
 * is skipped because a feature is not configured reports `skipped` and is not counted as a pass —
 * the same rule the enterprise doctor follows, and for the same reason: a report saying "11 checks
 * passed" over a deployment where four could not run is a report that gets quoted.
 */
import { writeFileSync } from 'node:fs';

const BASE = (process.env.TRUSTOS_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PREFIX = process.env.TRUSTOS_API_PREFIX ?? '/api';
const TIMEOUT_MS = Number(process.env.TRUSTOS_SMOKE_TIMEOUT_MS ?? 10_000);

/**
 * A route that exists and requires authentication.
 *
 * Configurable, because it differs per service. The default is the one `api-example` exposes; a
 * gateway or a console has its own, and probing a route that does not exist proves nothing — it
 * returns 404, which is neither the refusal being tested nor a failure worth reporting as one.
 */
const PROTECTED_ROUTE = process.env.TRUSTOS_SMOKE_PROTECTED_ROUTE ?? '/audit-logs';

const results = [];

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    return { status: response.status, body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, proves, fn) {
  const startedAt = Date.now();

  try {
    const outcome = await fn();

    results.push({
      name,
      proves,
      status: outcome?.skipped ? 'skipped' : 'pass',
      detail: outcome?.detail ?? null,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    results.push({
      name,
      proves,
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --- 1. health ----------------------------------------------------------------

await check('health', 'The process is alive and answering.', async () => {
  const { status, body } = await request('/health');

  expect(status === 200, `GET /health returned ${status}`);
  expect(body?.status === 'ok', `GET /health reported "${body?.status}"`);

  /*
   * Liveness must not touch a dependency. A health check that queried the database would turn a
   * database blip into a restart loop, which is worse than the blip.
   */
  expect(
    Array.isArray(body?.checks) && body.checks.length === 0,
    'GET /health ran dependency checks; liveness must not touch a dependency.',
  );

  return { detail: `${body.service} ${body.version} in ${body.environment}` };
});

// --- 2. readiness -------------------------------------------------------------

await check('readiness', 'Every required dependency answered.', async () => {
  const { status, body } = await request('/ready');

  expect(status === 200, `GET /ready returned ${status} — a dependency is down`);
  expect(body?.status === 'ok', `readiness reported "${body?.status}"`);

  const failing = (body.checks ?? []).filter((entry) => entry.status !== 'ok');
  expect(failing.length === 0, `failing: ${failing.map((entry) => entry.name).join(', ')}`);

  /*
   * Readiness must not leak infrastructure detail. A connection string in a readiness body is a
   * connection string on the least access-controlled endpoint a service has.
   */
  const serialized = JSON.stringify(body);
  for (const leak of ['postgres://', 'postgresql://', 'password', 'secret']) {
    expect(!serialized.toLowerCase().includes(leak), `readiness body contains "${leak}"`);
  }

  return { detail: `${body.checks.length} dependency check(s) passed` };
});

// --- 3. an unauthenticated request is refused ---------------------------------

await check('authentication', 'A protected route refuses an unauthenticated caller.', async () => {
  const { status } = await request(`${PREFIX}${PROTECTED_ROUTE}`);

  expect(
    status !== 404,
    `${PREFIX}${PROTECTED_ROUTE} does not exist on this service. Set TRUSTOS_SMOKE_PROTECTED_ROUTE ` +
      'to a route that does — probing a missing route proves nothing.',
  );
  expect(status === 401 || status === 403, `expected 401 or 403, got ${status}`);

  return { detail: `refused with ${status}` };
});

// --- 4. login -----------------------------------------------------------------

const credentials = {
  email: process.env.TRUSTOS_SMOKE_EMAIL,
  password: process.env.TRUSTOS_SMOKE_PASSWORD,
};

let accessToken = null;
let ownOrganizationId = null;

await check('login', 'A seeded user can authenticate.', async () => {
  if (!credentials.email || !credentials.password) {
    return {
      skipped: true,
      detail:
        'TRUSTOS_SMOKE_EMAIL and TRUSTOS_SMOKE_PASSWORD are not set. Nothing was proved about login.',
    };
  }

  const { status, body } = await request(`${PREFIX}/auth/login`, {
    method: 'POST',
    body: JSON.stringify(credentials),
  });

  expect(status === 200 || status === 201, `login returned ${status}`);

  /*
   * The token is under `tokens`, alongside the refresh token and the expiry. Reading `accessToken`
   * from the top level is the obvious guess and it is wrong — which is the sort of thing a smoke
   * test finds and a unit test does not, because a unit test uses the type.
   */
  accessToken = body?.tokens?.accessToken ?? body?.accessToken ?? null;
  expect(typeof accessToken === 'string', 'no access token in the response');

  /* Remembered so the tenant-isolation check can ask for an organization this user is not in. */
  ownOrganizationId = body?.organizations?.[0]?.id ?? null;

  return { detail: `authenticated${ownOrganizationId ? ` into ${ownOrganizationId}` : ''}` };
});

const authorized = () => ({ authorization: `Bearer ${accessToken}` });

// --- 5. an authenticated read -------------------------------------------------

await check('authorized read', 'An authenticated caller reaches a protected route.', async () => {
  if (!accessToken) return { skipped: true, detail: 'No token; login was skipped or failed.' };

  const { status } = await request(`${PREFIX}${PROTECTED_ROUTE}`, { headers: authorized() });
  expect(status === 200, `expected 200, got ${status}`);

  return { detail: 'read succeeded' };
});

// --- 6. tenant isolation ------------------------------------------------------

await check('tenant isolation', 'A caller cannot reach another organization.', async () => {
  if (!accessToken) return { skipped: true, detail: 'No token; login was skipped or failed.' };

  /*
   * An organization the caller is not a member of. Supplied when a real one exists in the
   * environment; otherwise an id that cannot belong to anybody, which still exercises the refusal
   * — the check is that a caller cannot read an organization they are not in, and an id that
   * exists elsewhere and an id that exists nowhere are the same request from the server's side.
   */
  const foreign = process.env.TRUSTOS_SMOKE_FOREIGN_ORG_ID ?? 'org_not_a_member_of_this_one';

  expect(foreign !== ownOrganizationId, 'the foreign organization is the caller’s own');

  const { status } = await request(`${PREFIX}/organizations/${foreign}`, { headers: authorized() });

  expect(
    status === 403 || status === 404,
    `a cross-tenant read returned ${status}; expected 403 or 404`,
  );

  return { detail: `refused with ${status}` };
});

// --- 7. RBAC ------------------------------------------------------------------

await check('RBAC', 'A permission the caller lacks is refused.', async () => {
  if (!accessToken) return { skipped: true, detail: 'No token; login was skipped or failed.' };

  const { status } = await request(`${PREFIX}/admin/roles`, {
    method: 'POST',
    headers: authorized(),
    body: JSON.stringify({ name: 'smoke-test-role', permissions: ['*'] }),
  });

  /*
   * A 404 is acceptable: the route may not exist on this service. What is not acceptable is a
   * 200 — a smoke user creating a wildcard role would mean the permission check did not run.
   */
  expect(status !== 200 && status !== 201, `role creation succeeded with ${status}`);

  return { detail: `refused with ${status}` };
});

// --- 8. correlation ids -------------------------------------------------------

await check('correlation id', 'A request id is echoed, so logs can be traced.', async () => {
  const header = process.env.TRUSTOS_REQUEST_ID_HEADER ?? 'x-request-id';
  const sent = `smoke-${Date.now()}`;

  const { headers } = await request('/health', { headers: { [header]: sent } });
  const echoed = headers.get(header);

  expect(echoed !== null, `no ${header} in the response`);
  return { detail: echoed === sent ? 'echoed the id sent' : `assigned ${echoed}` };
});

// --- 9. security headers ------------------------------------------------------

await check('security headers', 'The response carries the headers the policy sets.', async () => {
  const { headers } = await request('/health');

  const required = ['x-content-type-options', 'x-frame-options'];
  const missing = required.filter((name) => headers.get(name) === null);

  expect(missing.length === 0, `missing: ${missing.join(', ')}`);
  return { detail: required.join(', ') };
});

// --- 10. no stack trace on an error -------------------------------------------

await check('error shape', 'A failure returns a structured error, not a stack trace.', async () => {
  const { status, body } = await request(`${PREFIX}/this-route-does-not-exist`);

  expect(status === 404, `expected 404, got ${status}`);
  expect(typeof body?.error === 'string', 'the error has no code');
  expect(typeof body?.requestId === 'string', 'the error has no request id to trace');

  /*
   * The stack check applies to a production-like environment only.
   *
   * `AllExceptionsFilter` includes a `debug` payload when `NODE_ENV` is development, deliberately —
   * a developer wants the stack. Asserting its absence against a development service would be
   * asserting that a feature is broken.
   *
   * So the check runs when the service reports a non-development environment, which it does on
   * `/health`. Running these smoke tests against a development service therefore skips this one,
   * and says so rather than passing.
   */
  const { body: health } = await request('/health');

  if (health?.environment === 'development') {
    return {
      skipped: true,
      detail:
        'The service reports NODE_ENV=development, where a debug payload is intended. Run against ' +
        'a production-like environment to check that stacks are withheld.',
    };
  }

  const serialized = JSON.stringify(body ?? '');
  expect(!serialized.includes('at Object.'), 'the response contains a stack trace');
  expect(!serialized.includes('node_modules'), 'the response contains a file path');

  return { detail: 'structured, with no stack' };
});

// --- 11. the AI gateway, if configured ----------------------------------------

await check('AI gateway', 'The AI gateway answers, if one is configured.', async () => {
  if (process.env.TRUSTOS_SMOKE_AI !== 'true') {
    return { skipped: true, detail: 'TRUSTOS_SMOKE_AI is not "true"; nothing was proved about AI.' };
  }

  const { status } = await request(`${PREFIX}/ai/health`, { headers: authorized() });
  expect(status === 200, `AI health returned ${status}`);

  return { detail: 'answered' };
});

// --- the report ---------------------------------------------------------------

const passed = results.filter((entry) => entry.status === 'pass');
const failed = results.filter((entry) => entry.status === 'fail');
const skipped = results.filter((entry) => entry.status === 'skipped');

const report = {
  baseUrl: BASE,
  ranAt: new Date().toISOString(),
  node: process.version,
  summary: {
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    skipped: skipped.length,
  },
  note:
    'A skipped check is not a passed check. Counting them together would produce a number that ' +
    'reads as coverage and is not.',
  checks: results,
};

writeFileSync('smoke-report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const entry of results) {
  const mark = entry.status === 'pass' ? 'PASS' : entry.status === 'fail' ? 'FAIL' : 'SKIP';
  process.stdout.write(`${mark}  ${entry.name.padEnd(18)} ${entry.detail ?? ''}\n`);
}

process.stdout.write(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped — smoke-report.json\n`,
);

if (skipped.length > 0) {
  process.stdout.write('A skipped check is not a passed check.\n');
}

process.exit(failed.length > 0 ? 1 : 0);
