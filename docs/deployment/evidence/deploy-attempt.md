# Deploy attempt, 2026-08-27

The first deploy of the post-phase-15 build to the live Railway service. **It failed, the live
service was unaffected, and both of those are the system working.**

## What happened

|              |                                                           |
| ------------ | --------------------------------------------------------- |
| Deployment   | `1c0fda9b-dae8-4ed6-9843-283f733093dd`                    |
| Build        | **succeeded** — image `sha256:c63694e6…` built and pushed |
| Start        | **refused**                                               |
| Live service | **untouched** — still serving `d8a98a23`, uptime 14d 21h  |

## Why it refused

Reproduced locally with Railway's exact variable set:

```text
Refusing to start. Security policy is invalid:
  - allowedIdentityProviders: the local provider is intended for development, tests and
    lightweight deployments. Set IDENTITY_PROVIDER=oidc, or accept this explicitly with
    SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true.

The application will not start with an unsafe security policy.
```

The service has no `IDENTITY_PROVIDER` variable, so it defaults to `local`. The build that has been
running since 2026-08-12 predates `@trustos/security-policy` being wired into `api-example`, so it
never made this check. The new build does, and refuses.

**This is the control working, not a defect.** A framework that started with a development identity
provider in an environment named `production` would be a framework whose security policy is
decorative.

## Why the live service survived

A `railway.json` was added at the repository root immediately before this attempt, carrying
`healthcheckPath: /health`.

That file did not previously exist where Railway reads it. The seven added in phase 15 live in
`apps/*/`, and this service builds from the repository root — so Railway had **no health check
configured at all**, and would have routed traffic to the new deployment whether or not it started.

Without that one file, this attempt would have replaced a fifteen-day-stable service with one that
cannot boot, and nothing would have caught it.

## What has to happen before it can deploy

One of two decisions, neither of which a deployment tool should make on its own:

**Pilot** — keep the seeded local accounts working:

```bash
railway variables --service trustos-api --skip-deploys \
  --set "SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true" \
  --set "TRUSTOS_ENVIRONMENT=dev"
```

**Production-correct** — configure a real identity provider:

```bash
railway variables --service trustos-api --skip-deploys \
  --set "IDENTITY_PROVIDER=oidc" \
  --set "OIDC_ISSUER_URL=https://<issuer>/realms/trustos" \
  --set "OIDC_CLIENT_ID=trustos-api" \
  --set "OIDC_CLIENT_SECRET=<secret>"
```

Then `railway up --service trustos-api`, then
`TRUSTOS_BASE_URL=https://trustos-api-production.up.railway.app npm run smoke`.

Rollback target if needed: `d8a98a23-5587-434b-a7cd-3791e0b3b802`.

## What this attempt did establish

- The **whole workspace builds on Railway** — 171 packages and the application, from a clean `npm
ci`, on their builder. That was previously untested.
- The **health check protects the service**, verified rather than assumed.
- The **security policy refuses in production**, verified against a real deployment rather than in
  a unit test.

Three things that were PARTIAL on evidence are now demonstrated.
