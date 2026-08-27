# Environments

Three, and only two are provisioned.

|                       | DEV                    | UAT                    | PROD            |
| --------------------- | ---------------------- | ---------------------- | --------------- |
| Railway project       | `trustos-dev`          | `trustos-uat`          | **not created** |
| Database              | its own                | its own                | its own         |
| Secrets               | its own                | its own                | its own         |
| Domains               | `*-dev.up.railway.app` | `*-uat.up.railway.app` | a real domain   |
| `NODE_ENV`            | `production`           | `production`           | `production`    |
| `TRUSTOS_ENVIRONMENT` | `dev`                  | `uat`                  | `prod`          |
| Identity              | local, permitted       | local or OIDC          | **OIDC**        |
| Seeded demo data      | yes                    | no                     | never           |
| Swagger at `/docs`    | optional               | off                    | off             |

## Why `NODE_ENV=production` in DEV

Because that is what the word means to Node: it selects the production build of every dependency,
disables development-only paths, and is what a deployed service runs under.

A DEV environment running `NODE_ENV=development` is a DEV environment testing a different
codepath from the one that will be deployed — including the error filter, which includes a stack
trace in development and withholds it in production.

## Why `TRUSTOS_ENVIRONMENT` exists

`NODE_ENV` cannot tell UAT from production, because both are `production`.

`TRUSTOS_ENVIRONMENT` can, and three things read it:

- `@trustos/governance-environment-config` refuses a lower-environment credential in a higher
  environment — refused at load, not at first use, because by first use it has already worked once.
- The audit trail records which environment an action happened in.
- The security policy's residency rules read it.

## No credential crosses an environment

Each project has its own database, its own `JWT_SECRET`, its own `JWT_REFRESH_SECRET` and its own
identity configuration. A UAT token presented to production fails signature verification, because
the secrets differ.

That is the mechanism, and it only works if the secrets are actually different. Generate each one
separately:

```bash
openssl rand -base64 48 | tr -d '\n'
```

Do not copy DEV's secrets into UAT to save time. The saving is one command and the cost is that UAT
and DEV become one trust boundary.

## Setting them up

```bash
./scripts/railway-environments.sh          # dry run — shows every command, changes nothing
./scripts/railway-environments.sh --apply  # execute
```

It creates `dev` and `uat` by duplicating the existing environment, then does the step a manual
setup skips: **it rotates the signing secrets in all three**. `railway environment new --duplicate`
copies variables, so without rotation every environment shares a `JWT_SECRET` and a UAT token
verifies in production — the exact thing the section above says must not happen.

It sets `TRUSTOS_ENVIRONMENT` per environment, turns Swagger off everywhere, and leaves
**production needing OIDC**: `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION` is set in DEV and UAT and
deliberately not in production, so production refuses to start until a real identity provider is
configured. That refusal is the policy working.

It does not deploy. Deploying is a separate decision, and a script that both provisions and ships
is a script that does the second thing while you are still reading the first.

**It provisions paid infrastructure** — one Postgres and one service instance per environment — so
run it yourself rather than having automation run it for you.

## PROD is documented and not created

Deliberately. A production project created "ready for later" is a production project somebody
deploys to, and the readiness specification says to prepare its configuration only.

Before one is created, the items marked FAIL and PARTIAL in
[`pilot-readiness.md`](pilot-readiness.md) need addressing — in particular the ones about Railway's
own backup and restore, which this pilot has not exercised.

### What production would need beyond UAT

|            |                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Identity   | OIDC. `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION` stays unset                                 |
| HSTS       | On. Forced by the security policy when unset; refused if explicitly disabled                    |
| CORS       | Exact origins. `*` and any `http://` origin are refused                                         |
| Swagger    | Off                                                                                             |
| Seed       | Never run. The seed script refuses in production by construction                                |
| Backups    | Railway's, with a **verified restore** — see `evidence/restore-test.md` for what verified means |
| Migrations | Applied in a window with somebody watching, not by `preDeployCommand`                           |
| Replicas   | More than one, which nothing here has tested                                                    |

The last row is worth stating. Every measurement in this repository is single-replica. Running two
replicas changes the idempotency story, the rate limiter's counters and the scheduler's assumptions,
and none of that has been exercised.
