# Deploying TrustOS on Railway

## The topology

```text
Railway project: trustos-dev
│
├── PostgreSQL                                    managed
│
├── trustos-api                          public   api-example — reference API, smoke target
│                                                 runs migrations before deploy
├── internal-app-gateway                 private  the entrance internal applications call
├── governance-tool                      public   the console runtime
├── enterprise-governance-admin          private  data governance, policy, APIs, continuity
├── financial-product-admin              private  the product designer
├── sre-operations-console               private  service health and incidents
└── api-developer-portal                 public   the developer-facing catalog
```

`trustos-uat` is the same shape with its own database, its own secrets and its own domains.

**No PROD project is created.** Its configuration is documented in
[`environments.md`](environments.md) and nothing is provisioned — a production project created
"ready for later" is a production project somebody deploys to.

### What is deliberately absent

The readiness specification's example topology names `workflow-worker`, `job-worker` and
`ai-gateway`. **Those applications do not exist in this repository**, and the specification says
not to invent them.

`@trustos/job-runtime`, `@trustos/scheduler`, `@trustos/workflow-runtime` and
`@trustos/ai-gateway` are **libraries**. A deployment hosts them inside its own process; none ships
a `main`. See [`current-state-assessment.md`](current-state-assessment.md).

**No Redis**, because nothing in the repository requires it. **No object storage**, for the same
reason. Adding either would be adding an operational dependency to satisfy a diagram.

### Which services are public

Three: `trustos-api`, `governance-tool` and `api-developer-portal`.

`internal-app-gateway` is private by name and by purpose — it is the entrance internal applications
call over Railway's private network, and exposing it publicly would be exposing the thing that
exists to be the only door.

The three admin consoles are private because they administer the platform. A deployment that wants
them reachable puts them behind its own ingress with its own controls, deliberately.

## Creating the project

```bash
railway login
railway init --name trustos-dev
railway add --database postgres
```

Railway injects `DATABASE_URL` into every service in the project. Do not set it by hand.

## Adding a service

Each service is the same repository with a different `SERVICE` build argument. In the Railway
dashboard, or with the CLI:

```bash
railway add --service trustos-api
railway service trustos-api
railway variables --set "RAILWAY_DOCKERFILE_PATH=Dockerfile"
```

Then set the build argument. Railway reads `railway.json` from the service's root directory, so
point each service at its application:

| Service                       | Root directory | `SERVICE` build arg           |
| ----------------------------- | -------------- | ----------------------------- |
| `trustos-api`                 | `/`            | `api-example`                 |
| `internal-app-gateway`        | `/`            | `internal-app-gateway`        |
| `governance-tool`             | `/`            | `governance-tool`             |
| `enterprise-governance-admin` | `/`            | `enterprise-governance-admin` |
| `financial-product-admin`     | `/`            | `financial-product-admin`     |
| `sre-operations-console`      | `/`            | `sre-operations-console`      |
| `api-developer-portal`        | `/`            | `api-developer-portal`        |

## Variables

Every service needs these. Copy [`.env.example`](../../.env.example) and read it — each variable
there says what it is for and which are deliberately absent.

```bash
railway variables --set "NODE_ENV=production" \
                  --set "TRUSTOS_ENVIRONMENT=dev" \
                  --set "PORT=3000" \
                  --set "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')" \
                  --set "JWT_REFRESH_SECRET=$(openssl rand -base64 48 | tr -d '\n')" \
                  --set "LOG_LEVEL=info" \
                  --set "TRUST_PROXY=true" \
                  --set "CORS_ORIGINS=https://console-dev.example.com" \
                  --set "OPENAPI_ENABLED=false"
```

Three of those need explanation.

**`TRUSTOS_ENVIRONMENT` is not `NODE_ENV`.** A UAT service runs with `NODE_ENV=production` —
that is what the word means to Node — so `NODE_ENV` cannot tell UAT from production.
`TRUSTOS_ENVIRONMENT` can, and it is what `@trustos/governance-environment-config` refuses a
lower-environment credential against.

**`TRUST_PROXY=true` on Railway and `false` locally.** Railway sets `X-Forwarded-For`; trusting the
header without a proxy in front lets a caller choose their own source address, which defeats every
rate limit and IP allowlist.

**`JWT_SECRET` and `JWT_REFRESH_SECRET` must differ**, and must be at least 32 characters in
production. The security policy refuses to start otherwise.

### Private networking

Services in one Railway project reach each other at `<service>.railway.internal` without leaving
the network:

```bash
railway variables --set "TRUSTOS_GATEWAY_URL=http://internal-app-gateway.railway.internal:3000"
```

Use the internal name for every service-to-service call. A public URL for an internal call is a
call that leaves the network and comes back, and it is reachable by anybody who finds it.

## Custom domain

The platform's public name is **https://trustos.cambobia.com**, attached to the
`governance-tool` service in the `production` environment.

|                          |                                                                    |
| ------------------------ | ------------------------------------------------------------------ |
| Railway project          | `TrustOS-Framework`                                                |
| Environment              | `production`                                                       |
| Service                  | `governance-tool`                                                  |
| Custom domain            | `trustos.cambobia.com`                                             |
| Target port              | 8080                                                               |
| Railway-generated domain | `governance-tool-production.up.railway.app` — kept for diagnostics |

Attached with:

```bash
railway domain trustos.cambobia.com --service governance-tool --port 8080
```

which returns the DNS record to add. The record, the provider it belongs in and how to verify
it are in [dns.md](dns.md). The Railway-generated domain stays available, but it is not the
platform's name — anything user-facing should say the custom domain.

Two things to know before treating the domain as finished, both covered in
[custom-domain-assessment.md](custom-domain-assessment.md):

- **The root path returns a JSON 404.** Every deployed service is a JSON API; no web interface
  exists in the repository yet. `https://trustos.cambobia.com/health` is the endpoint that
  demonstrates the domain works.
- **The environment is a pilot.** `TRUSTOS_ENVIRONMENT=dev` on every service, and the
  production readiness gates have not passed. It is _TrustOS Platform v0.1 — Pilot_, whatever
  the Railway environment is called.

## Migrations

**One service runs them.** `trustos-api`'s `railway.json` carries:

```json
"preDeployCommand": "npm run db:deploy"
```

and no other service does. Seven services each running `migrate deploy` on boot is seven concurrent
migration attempts against one database — Prisma takes an advisory lock, so six of them wait and
one of the six times out, and the deploy that fails is the one nobody was watching.

See [`database-migrations.md`](database-migrations.md).

## Health checks

Every service exposes both:

|               | Question                       | Touches a dependency? |
| ------------- | ------------------------------ | --------------------- |
| `GET /health` | Is this process alive?         | **no**                |
| `GET /ready`  | Should traffic be routed here? | yes                   |

`railway.json` points the health check at `/health`, deliberately.

A platform health check on `/ready` turns a database blip into a restart loop: the database is
briefly unavailable, readiness fails, the platform kills the container, it restarts, readiness
fails again because the database is still recovering. That is measurably worse than the blip, and
it is the most common self-inflicted outage in a containerized deployment.

Verified: with the database stopped, `/health` returns 200 and `/ready` returns 503 with
`{"name":"database","status":"down","detail":"database unreachable"}` — and no connection string.
See [`evidence/failure-tests.md`](evidence/failure-tests.md).

## Deploying

```bash
railway up --service trustos-api
```

Or connect the GitHub repository and let Railway build on push to `main`. The release process is in
[`../release/release-process.md`](../release/release-process.md).

## Rolling back

```bash
railway deployment list --service trustos-api
railway redeploy <deployment-id>
```

**A code rollback is not a schema rollback.** Redeploying a previous image against a database that
has run a newer migration gives you old code reading a new schema, which works until it does not.
The recovery procedure for a bad migration is in
[`database-migrations.md`](database-migrations.md#when-a-migration-goes-wrong), and it is
forward-only.

## Troubleshooting

### The service will not start

Read the first log line. `@trustos/config` validates every variable before a port is bound and
reports **all** the problems at once:

```text
Invalid configuration:
  - DATABASE_URL: DATABASE_URL must be a PostgreSQL connection string.
  - LOG_LEVEL: Required
```

If the message is `Refusing to start` instead, it is the security policy:

```text
Refusing to start. The security policy is not safe for this environment:
  - http.corsOrigins: "*" is not permitted in production.
```

Both are deliberate. A service that started with a missing secret would fail at the first request
instead of at deploy time.

### The health check fails but the service is running

Check `PORT`. Railway injects it, and a service hardcoding 3000 while Railway routes to something
else answers nothing.

### Readiness fails and health passes

That is the split working. A dependency is down; read `/ready`'s body, which names the failing
check. The service will recover without a restart when the dependency does — verified in
[`evidence/failure-tests.md`](evidence/failure-tests.md).

### The container takes 30 seconds to stop

`dumb-init` is not PID 1. Without it Node is PID 1, PID 1 ignores signals it has no handler for,
and the platform waits for its timeout before killing the process mid-request.

The `Dockerfile` sets `ENTRYPOINT ["dumb-init", "--"]` and CI fails the build if a stop takes
fifteen seconds or more.

### Everything is slow after a deploy

Check whether more than one service has `preDeployCommand`. See Migrations above.
