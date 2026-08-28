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

`dev` and `uat` exist. Both were created by duplicating `production`, migrated, and deployed on
2026-08-28. All seven services run in each.

|                       | `production`                                | `dev`        | `uat`        |
| --------------------- | ------------------------------------------- | ------------ | ------------ |
| Services deployed     | 7                                           | 7            | 7            |
| Postgres              | own instance                                | own instance | own instance |
| `TRUSTOS_ENVIRONMENT` | `dev`                                       | `dev`        | `uat`        |
| `NODE_ENV`            | `production`                                | `production` | `production` |
| Signing secrets       | distinct                                    | distinct     | distinct     |
| `CORS_ORIGINS`        | set on `governance-tool` only               | unset        | unset        |
| Custom domain         | `trustos.cambobia.com` on `governance-tool` | none         | none         |

[`../../scripts/railway-environments.sh`](../../scripts/railway-environments.sh) documents the
intended shape and is still the reference for what a fresh setup needs. It was not the thing that
was run, for two reasons worth recording:

- **It configures `trustos-api` only.** The rotation step is the point of the script, and applying
  it to one of seven services leaves the other six sharing a `JWT_SECRET` across all three
  environments — the exact hole it exists to close. Rotation was done for all seven, in `dev` and
  `uat`.
- **It rewrites `production`.** It rotates production's signing secrets, which invalidates every
  token issued against a live environment, and sets `TRUSTOS_ENVIRONMENT=prod` there. Neither was
  asked for. Production was left untouched.

Two things the duplicate copied that had to be undone afterwards, both of which are the same class
of mistake as the shared `JWT_SECRET`:

- **Signing secrets.** Confirmed shared immediately after duplication — the same `JWT_SECRET`
  fingerprint in all three environments, so a UAT token would have verified in production. Rotated
  in `dev` and `uat`, per service, since production already gives each service its own.
- **`CORS_ORIGINS`.** `dev` and `uat` inherited `https://trustos.cambobia.com`, the production
  console origin, meaning a page served from the production domain could call the `dev` and `uat`
  APIs with credentials. Removed from both; neither has a frontend, and an absent value means CORS
  is never enabled at all rather than enabled-and-empty.

Migrations were applied to each new database separately over Railway's TCP proxy
(`DATABASE_PUBLIC_URL`), because the container does not migrate on boot and
`postgres.railway.internal` resolves only inside Railway's network:

```bash
DATABASE_URL="$(railway variables --service Postgres --environment dev --kv \
  | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" npm run db:deploy
```

Verified afterwards: `/health` and `/ready` answer `200` in both environments, each with its own
database check passing, and the `JWT_SECRET` and `DATABASE_URL` fingerprints differ across all
three.

### Still open

`production` reports `TRUSTOS_ENVIRONMENT=dev`. That was the honest label when it was the only
environment; now that a real `dev` exists it is actively confusing. Changing it to `prod` is not a
cosmetic edit — it is what `@trustos/governance-environment-config` reads to enforce the production
identity rules, and every service currently carries
`SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true`. Flipping the label on a live environment
serving a public domain, without first configuring OIDC, is a change to make deliberately and
watch, not one to fold into an environment-provisioning run.

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
