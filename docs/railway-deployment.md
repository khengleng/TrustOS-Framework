# Railway deployment

How to deploy a TrustOS service built on this framework to
[Railway](https://railway.com). The example API is used throughout; the SaaS
starter and any product built from it deploy identically.

---

## 1. What you are deploying

A Railway **project** holds one PostgreSQL database and one service per
application:

```
TrustOS project
├── Postgres            (Railway plugin — provides DATABASE_URL)
├── api-example         (NestJS, public, health-checked)
└── admin-example       (Next.js, public)
```

All services build from the same repository root, because this is an npm
workspace monorepo: the framework packages must be built before the application
that imports them.

---

## 2. Create the project and database

```bash
npm i -g @railway/cli
railway login
railway init                 # creates the project
railway add --database postgres
```

The Postgres plugin publishes `DATABASE_URL` into the project. **Do not paste a
connection string into a variable yourself** — reference the plugin so the value
follows credential rotation:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
```

---

## 3. Create the API service

In the Railway dashboard, create a service from your GitHub repository, then:

**Settings → Config-as-code**

```
apps/api-example/railway.json
```

That file already declares everything:

```json
{
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm ci && npm run build:packages && npm run build -w @trustos/api-example"
  },
  "deploy": {
    "startCommand": "node apps/api-example/dist/main.js",
    "preDeployCommand": "npm run db:deploy",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

Three details worth understanding:

- **`npm ci` runs the root `postinstall`**, which runs `prisma generate`. The
  Prisma client must exist before TypeScript compiles anything that imports it.
- **`preDeployCommand` runs migrations** (`prisma migrate deploy`) once per
  deploy, before the new instances take traffic. It never generates a migration
  — `migrate deploy` only applies what is committed.
- **`healthcheckPath` is `/health`, not `/ready`.** Liveness must not depend on
  the database, or a brief database outage becomes a restart loop.

**Settings → Networking → Generate Domain** to get a public URL.

---

## 4. Set the variables

**Service → Variables**

```bash
NODE_ENV=production
PORT=${{PORT}}                       # Railway injects the port to bind
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<48 random bytes>
JWT_REFRESH_SECRET=<a different 48 random bytes>
LOG_LEVEL=info

SERVICE_NAME=trustos-api
SERVICE_VERSION=${{RAILWAY_GIT_COMMIT_SHA}}
CORS_ORIGINS=https://admin.yourdomain.com
TRUST_PROXY=true
OPENAPI_ENABLED=false
```

Generate each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The service refuses to start if a secret is missing, shorter than 32 characters,
a known placeholder, or identical to the other one. That is intentional: a
misconfigured deploy should fail visibly at boot, not serve traffic with a
guessable signing key.

`TRUST_PROXY=true` matters for the audit trail. Railway terminates TLS and
forwards the client address in `X-Forwarded-For`; without this flag the framework
ignores that header (correctly — trusting it unconditionally lets any caller
forge the IP in audit records) and every record would show the proxy's address.

`OPENAPI_ENABLED=false` in production unless the Swagger UI is deliberately part
of your public surface.

---

## 5. Create the admin service

A second service from the same repository:

**Settings → Config-as-code**: `apps/admin-example/railway.json`

**Variables**

```bash
NODE_ENV=production
NEXT_PUBLIC_API_BASE_URL=https://<your-api-domain>/api
```

`NEXT_PUBLIC_*` values are compiled into the browser bundle, so this is the only
variable the admin app gets and it must never be a secret. Changing it requires
a rebuild, not just a restart.

Add the admin domain to the API's `CORS_ORIGINS`.

---

## 6. Seed the first deployment

The seed is idempotent and skips demo accounts when `NODE_ENV=production`, so it
creates only the permission catalog and the five system roles:

```bash
railway run --service api-example npm run db:seed
```

There is deliberately no seeded production account. Create the first
super admin explicitly:

```bash
railway connect Postgres
```

```sql
-- after the user has registered through the API
UPDATE "User" SET "isSuperAdmin" = true WHERE email = 'you@yourdomain.com';
```

Then harden the audit table, which the application must never be able to rewrite:

```sql
REVOKE UPDATE, DELETE ON "AuditLog" FROM CURRENT_USER;
```

---

## 7. Verify

```bash
curl https://<api-domain>/health     # 200, no database involved
curl https://<api-domain>/ready      # 200 with {"status":"ok"} once Postgres answers
curl -i https://<api-domain>/api/nope
#   404 with {"error":"not_found", ...} and an x-request-id header,
#   and no stack trace — that is how you know NODE_ENV is really production
```

Check the deploy logs for the startup line. It prints the effective
configuration with every secret replaced by `[redacted]`; if you can read a
secret there, stop and file it as an incident.

---

## 8. Operating

**Migrations.** Generated locally, applied by `preDeployCommand`:

```bash
npm run db:migrate -- --name add_widget_table   # local, creates the file
git add packages/database/prisma/migrations     # commit it
```

Railway applies it on the next deploy. `migrate deploy` never generates or
resets anything.

**Rollback.** Railway redeploys the previous build from the dashboard. Note that
a rollback does **not** undo a migration — write migrations so the previous
application version can still run against the new schema (add columns, do not
rename them; drop in a later release).

**Scaling.** `numReplicas` in `railway.json`. The framework is stateless apart
from PostgreSQL: request context is per-request, and sessions live in the
database. Watch the connection pool before raising replica count on a small
Postgres plan — that is the first limit you will hit.

**Logs.** JSON on stdout, one object per line, each with `requestId`, `service`,
`env`, and — after authentication — `actorId` and `organizationId`. Search by
`requestId` to connect a user's report to the server side and to the audit
trail.

---

## 9. Troubleshooting

| Symptom                                              | Cause                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Build fails on `Cannot find module '@prisma/client'` | `postinstall` did not run. Ensure the build command starts with `npm ci`, not `npm ci --ignore-scripts`.               |
| Build fails on `Cannot find module '@trustos/...'`   | `npm run build:packages` is missing from the build command. Packages must be compiled before an app that imports them. |
| `Invalid configuration:` at boot                     | Exactly the listed variables are missing or invalid. The message names each one.                                       |
| Health check fails, logs look fine                   | The service is not binding `0.0.0.0:$PORT`. Do not hardcode `PORT`.                                                    |
| `/ready` returns 503                                 | The database is unreachable. `/health` still returns 200 by design; check the Postgres plugin and `DATABASE_URL`.      |
| Every audit record shows the same IP                 | `TRUST_PROXY` is not `true`.                                                                                           |
| CORS errors in the admin app                         | The admin origin is missing from the API's `CORS_ORIGINS` (comma-separated, no wildcard in production).                |
| 401 immediately after deploy                         | `JWT_SECRET` changed; all outstanding access tokens are invalid. Expected — clients refresh or sign in again.          |
