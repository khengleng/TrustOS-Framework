# Failure test results

§27 of the readiness specification: controlled failures against a running service.

Every result below was produced against `api-example` running in production mode against
PostgreSQL 17, with migrations applied and demo data seeded. Nothing here is a description of what
the code should do.

## Environment

|          |                                                                    |
| -------- | ------------------------------------------------------------------ |
| Service  | `api-example`, `NODE_ENV=production`, `TRUSTOS_ENVIRONMENT=uat`    |
| Database | PostgreSQL 17, local, 9 migrations applied                         |
| Identity | local provider, `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true` |
| Ran      | 2026-08-27                                                         |

## 1. Database unavailable

The database was stopped while the service was running.

|                                   | Result                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| `GET /health`                     | **200** — liveness does not touch a dependency                        |
| `GET /ready`                      | **503** with `"status": "down"`                                       |
| The failing check                 | `{"name":"database","status":"down","detail":"database unreachable"}` |
| The process                       | **still alive**                                                       |
| Connection string in the response | **no**                                                                |

The important half is the first row. A liveness probe that queried the database would turn a
database blip into a restart loop, and a restart loop is worse than the blip: the service comes
back, fails the probe, and is killed again while the database is still recovering.

The readiness detail says `database unreachable` and not the connection string. A readiness body is
one of the least access-controlled surfaces a service has.

## 2. Recovery without a restart

The database was started again. **`GET /ready` returned 200 within three seconds**, with no
restart and no intervention.

That is the behaviour the split makes possible: the platform never killed the container, so there
was nothing to recover.

## 3. Invalid environment variable

Started with `DATABASE_URL=not-a-url` and no `LOG_LEVEL`:

```text
Invalid configuration:
  - DATABASE_URL: DATABASE_URL must be a PostgreSQL connection string.
  - LOG_LEVEL: Required
Copy packages/config/.env.example to .env and fill in the required values.
```

**No port was bound.** The failure is at start-up rather than at the first request, which is the
difference between a deploy that fails visibly and a service that serves errors until somebody
notices.

Both problems are reported, not just the first. A validator that stops at the first error makes
fixing a misconfiguration an iterative process against a deploy loop.

## 4. Invalid and expired tokens

| Request                                         | Result  |
| ----------------------------------------------- | ------- |
| `Bearer not.a.real.token`                       | **401** |
| A structurally valid JWT with `exp` in the past | **401** |
| No `Authorization` header                       | **401** |

All three the same, deliberately: a service that answered differently for a malformed token and an
expired one would be telling a caller which of the two they have.

## 5. Unauthorized request

| Actor               | Action                                     | Result  |
| ------------------- | ------------------------------------------ | ------- |
| `auditor@acme.test` | Invite a member to their own organization  | **403** |
| `auditor@acme.test` | Read the member list                       | **403** |
| `auditor@acme.test` | Read a member list in another organization | **403** |
| `owner@acme.test`   | Invite a member                            | **201** |

The auditor holds neither `MEMBER_INVITE` nor `MEMBER_READ`, and the guard refuses both. The owner
holds them and succeeds, which is what makes the first row a permission check rather than a broken
route.

### One result worth explaining

`POST /api/organizations` as the auditor returns **201**, and that is correct rather than a finding.

The route carries `@AllowAnyAuthenticated()` and `@NoTenantRequired()`, with a comment saying why:
any authenticated user may found an organization, because they cannot hold an organization
permission before one exists. The auditor becomes the owner of the _new_ organization and gains
nothing in the existing one — which the three 403s above confirm.

A test asserting a 403 there would have been asserting that the framework's bootstrapping is
broken.

## 6. SIGTERM

`kill -TERM` against the running process: **stopped in under one second**.

The container image puts `dumb-init` at PID 1 for the same reason. Without it Node is PID 1, PID 1
ignores signals it has no handler for, and a container stop waits for the platform's timeout before
killing the process mid-request — Nest's shutdown hooks never run and the database connection is
never closed.

CI measures this rather than assuming it: the deployment job stops the container and fails if it
took fifteen seconds or more.

## 7. Structured logging

Every request produced a log line carrying what §18 requires:

```json
{
  "level": "info",
  "time": "2026-08-27T09:32:33.653Z",
  "service": "trustos-service",
  "env": "production",
  "version": "0.0.0",
  "requestId": "req_2a149c429b83494885ddbf0dcbfd28ad",
  "actorId": "user_demo_auditor",
  "organizationId": "org_demo_acme",
  "method": "POST",
  "path": "/api/organizations",
  "statusCode": 201,
  "durationMs": 4.03,
  "ip": "127.0.0.1",
  "msg": "request completed"
}
```

Timestamp, service, environment, request id, actor, organization, severity — all present.

The start-up line logs the whole configuration with `redactSecrets` applied:

```json
"database": { "url": "[redacted]" },
"auth": { "jwtSecret": "[redacted]", "jwtRefreshSecret": "[redacted]" }
```

Not omitted — **redacted**, so a reader can see the key was set without seeing its value. An
omitted key and an unset key look the same in a log, and the difference is what somebody is
debugging at the time.

## What was not tested

- **Worker termination.** There are no worker services; see
  [`../current-state-assessment.md`](../current-state-assessment.md).
- **AI provider unavailable.** No AI provider is configured. `@trustsystem/ai-gateway` ships no
  provider client, so there is nothing to make unavailable.
- **Queue backlog.** No queue is deployed.
- **Chaos against UAT.** No UAT environment exists, and the specification says not to run
  destructive chaos against one automatically.
