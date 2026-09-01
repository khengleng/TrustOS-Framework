# Deployment evidence

Everything the readiness scorecard's numbers come from. Produced against a running service with a
real PostgreSQL, not asserted.

| File                                                       | What it records                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [`smoke-report.json`](smoke-report.json)                   | Eleven smoke checks against `api-example` in production mode |
| [`smoke-report-restored.json`](smoke-report-restored.json) | The same eleven, against the **restored** database           |
| [`failure-tests.md`](failure-tests.md)                     | §27 — database unavailable, bad config, bad tokens, SIGTERM  |
| [`restore-test.md`](restore-test.md)                       | §26 — backup, restore, validation, application start, smoke  |

## Reproducing them

```bash
# A database.
createdb trustos_smoke
export DATABASE_URL="postgresql://localhost/trustos_smoke?schema=public"
npm run db:deploy
NODE_ENV=development npm run db:seed

# The service, in production mode.
npm run build -w @trustsystem/api-example
NODE_ENV=production TRUSTOS_ENVIRONMENT=uat PORT=3000 \
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  JWT_REFRESH_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  CORS_ORIGINS=https://example.com OPENAPI_ENABLED=false \
  IDENTITY_PROVIDER=local SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true \
  node apps/api-example/dist/main.js &

# The smoke tests.
TRUSTOS_BASE_URL=http://localhost:3000 \
  TRUSTOS_SMOKE_EMAIL=owner@acme.test \
  TRUSTOS_SMOKE_PASSWORD='TrustOSDemo2026!' \
  npm run smoke
```

`SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true` is set because this is a local reproduction with
the local identity provider. A real production deployment leaves it unset and uses OIDC — the
policy refuses the local provider otherwise, deliberately.

## What is not here

**A Railway deployment.** No project was created; see
[`../pilot-readiness.md`](../pilot-readiness.md), items 15 and 16, which are FAIL for that reason.

**A Railway backup restore.** The restore test used `pg_dump` and `pg_restore` against a local
PostgreSQL. Railway's managed backup is a different procedure with different failure modes and has
not been exercised.

**A penetration test.** None performed.
