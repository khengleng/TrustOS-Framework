# Deploying the Governance Tool

> Full Railway topology, Dockerfiles and CI live in `docs/deployment/`. This page covers what is
> specific to these two applications.

## Two deployables, deliberately

| Service                | Public                 | Reaches                   |
| ---------------------- | ---------------------- | ------------------------- |
| `governance-tool`      | Yes, to internal users | Nothing. Descriptors only |
| `internal-app-gateway` | Yes, to internal users | Every read and mutation   |

They are separate because the surface that lists what exists and the surface that reaches
production data have different blast radii. One process means one vulnerability reaches both.

Both run **one instance per environment**. `TRUSTOS_ENVIRONMENT` is read once at start-up and
refused if absent — there is no request field that selects an environment.

## Environment variables

| Variable                           | Required        | Notes                                                               |
| ---------------------------------- | --------------- | ------------------------------------------------------------------- |
| `TRUSTOS_ENVIRONMENT`              | yes             | `dev`, `uat` or `prod`. **Not** `NODE_ENV`                          |
| `NODE_ENV`                         | yes             | `production` in UAT as well as PROD — it controls runtime behaviour |
| `DATABASE_URL`                     | yes             | Audit and security events. Per environment                          |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | yes             | Per environment                                                     |
| `IDENTITY_PROVIDER`, `OIDC_*`      | yes in UAT/PROD | Enterprise SSO                                                      |
| `CORS_ALLOWED_ORIGINS`             | yes             | The internal front end's origin only                                |
| `LOG_LEVEL`                        | no              | Defaults to `info`                                                  |

No DEV or UAT value may work in PROD. `assertNoCrossEnvironmentCredential` refuses a shared
credential **reference** at load; the operational discipline behind it is that the secret store
holds three separate sets.

## What a deployment must wire

Both applications start with warnings, because each of these is a seam the framework deliberately
does not fill:

1. **An identity provider.** The default authenticates nobody — a default local provider would be
   a second, weaker way in.
2. **An access resolver.** The default refuses everything. One that granted from a token claim
   would be a template for exactly the mistake this layer exists to prevent.
3. **A resource registry.** Empty by default. Shipping a populated one would ship somebody's
   credentials and access classes.
4. **A read executor.** The gateway produces a plan; something has to run it, with the
   `credentialRef` resolved from the secret store.
5. **A forwarder.** Calls the TrustOS API **with the actor's credential**, never a service one.
6. **A persistent app catalog.** In memory by default; applications are lost on restart.

## Health and readiness

`GET /health` — the process is up.

`GET /ready` — the database answers and the identity provider is reachable. A gateway that
reported ready with no identity provider would take traffic it can only refuse.

## Rollback

An internal application rolls back by promoting the previous version; the runtime holds no state
of its own, so a container rollback is sufficient for the service itself.

An application whose _resources_ changed does not roll back cleanly — the previous version may
reference a resource that has been revoked. That is why `planPromotion` requires a rollback
target and why revoking a resource is a separate, audited action.
