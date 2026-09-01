# Custom domain assessment — trustos.cambobia.com

State of the deployment as found on 2026-08-28, before any domain work. Written so the
decisions below can be argued with rather than taken on trust: every claim here was checked
against the running deployment or the repository, and the check is named.

## Summary

The blocking finding is at the top because it changes what the domain can mean.

**There is no TrustOS web interface to point a domain at.** All seven deployed services are
NestJS JSON APIs. Every one of them answers `GET /` with a JSON `404`. The Governance Tool
serves console _descriptors_ — JSON documents describing what a console should contain — and
no code in the repository renders them. Pointing `trustos.cambobia.com` at any service today
gives a browser a JSON error object, not a portal.

Everything else needed for the domain is in place: TLS terminates at Railway, the security
headers are correct, `/health` and `/ready` both answer and leak nothing, and the database is
private.

## Environment

|                       |                                                              |
| --------------------- | ------------------------------------------------------------ |
| Railway project       | `TrustOS-Framework` (`cc96d5fe-6d54-4589-b077-6dc80eff5242`) |
| Environments          | `production` — the only one. DEV and UAT do not exist.       |
| `TRUSTOS_ENVIRONMENT` | `dev` on every service                                       |
| `NODE_ENV`            | `production` on every service                                |

The environment named `production` in Railway runs software that tells itself it is `dev`.
That is deliberate — `TRUSTOS_ENVIRONMENT` and `NODE_ENV` answer different questions, and the
apps say so at start-up — but it means the public name of this environment overstates it.
Per the readiness scorecard this is **TrustOS Platform v0.1 — Pilot**, not a production
service, and the domain should be described that way until the production gates pass.

## Services

Verified with `railway variables` per service, and by requesting each public URL.

| Railway service               | `SERVICE` build arg           | Kind     | `GET /`  | Public |
| ----------------------------- | ----------------------------- | -------- | -------- | ------ |
| `trustos-api`                 | `api-example`                 | JSON API | 404 JSON | yes    |
| `internal-app-gateway`        | `internal-app-gateway`        | JSON API | 404 JSON | yes    |
| `governance-tool`             | `governance-tool`             | JSON API | 404 JSON | yes    |
| `enterprise-governance-admin` | `enterprise-governance-admin` | JSON API | 404 JSON | yes    |
| `financial-product-admin`     | `financial-product-admin`     | JSON API | 404 JSON | yes    |
| `sre-operations-console`      | `sre-operations-console`      | JSON API | 404 JSON | yes    |
| `api-developer-portal`        | `api-developer-portal`        | JSON API | 404 JSON | yes    |
| `Postgres`                    | —                             | database | —        | **no** |

Despite the names, `sre-operations-console` and `api-developer-portal` are APIs. None of the
eleven applications in `apps/` except `admin-example` renders HTML, and `admin-example` is
not deployed.

### Which service is the portal

None of them. The closest candidate is `governance-tool`, which owns the platform's
governance surface — the application catalog, the console templates, the resource registry
and governed promotion. Its controllers are `GET /governance/apps`,
`GET /governance/consoles/:appId` and siblings. All return JSON.

It also starts with this warning, which is in the code, not a misconfiguration:

> No resources are registered. Every read will be refused with "no approved resource" until a
> deployment registers its own.

So even its API returns nothing useful in this deployment until a caller registers resources
through `GovernanceToolModule.forRoot`.

## Configuration relevant to a custom domain

Read from `packages/config/src/env-schema.ts` and the live services.

| Concern        | State                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port           | `PORT=8080`, bound `0.0.0.0` — correct for Railway                                                                                                          |
| Health         | `GET /health` → 200, excluded from the global prefix                                                                                                        |
| Readiness      | `GET /ready` → 200 with a real database check                                                                                                               |
| Health payload | service, version, environment, uptime, checks. No secrets, no topology, no credentials.                                                                     |
| TLS            | terminated by Railway (`server: railway-hikari`), valid certificate                                                                                         |
| HSTS           | `max-age=31536000; includeSubDomains`                                                                                                                       |
| Other headers  | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive CSP                                                                       |
| `TRUST_PROXY`  | `true`                                                                                                                                                      |
| Cookies        | none. Authentication is bearer-token; no service calls `res.cookie`.                                                                                        |
| Redirects      | none. No application performs an HTTP redirect.                                                                                                             |
| OIDC           | present in `@trustsystem/identity` but not wired into any deployed service — every service still carries `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true` |

### Base URL

**There is no base-URL variable.** The environment schema defines exactly twenty variables,
and none of them is `APP_URL`, `PUBLIC_URL`, `BASE_URL` or an equivalent. The only URL it
holds is `DATABASE_URL`. Nothing in the codebase constructs an absolute public URL, which is
consistent: with no redirects, no cookies and no email links, nothing needs one yet.

Adding one is therefore a real change to the configuration contract, not a value to fill in.
It should wait until something needs it — the first will probably be OIDC callbacks.

### CORS

`CORS_ORIGINS` is a comma-separated allow-list; when it is empty `enableCors` is never called
and the service simply has no CORS surface.

| Service           | `CORS_ORIGINS`                |
| ----------------- | ----------------------------- |
| `governance-tool` | `https://console.example.com` |
| `trustos-api`     | unset                         |

`console.example.com` is a placeholder that resolves to nothing. It is not a security problem
— an origin that does not exist cannot make a request — but it is the setting that would name
the real portal once one exists.

### Trust proxy

`TRUST_PROXY=true` is read into `config.http.trustProxy` and used in one place:
`resolveClientIp` in the request-context middleware, so audit records attribute the client IP
from `X-Forwarded-For` rather than Railway's proxy.

It is **not** applied to Express itself — no service calls `app.set('trust proxy', …)`. So
`req.protocol` reports `http` behind Railway's TLS termination, and `req.secure` is `false`.
Nothing currently reads either, which is why this has not caused a bug. It would matter the
moment the platform issues a cookie, builds an absolute URL or performs a redirect, and it
should be fixed before any of those ship rather than after.

## Security observations

- `x-powered-by: Express` is served. Minor version disclosure; worth removing.
- All seven application services hold public Railway domains. The governance, SRE, financial
  and developer-portal APIs have no reason to be reachable from the internet; Railway private
  networking already connects them to each other. Public exposure should shrink to whatever
  actually serves the public.
- The CSP is `default-src 'none'` with `frame-ancestors 'none'`. Correct for a JSON API, and
  it will block a web UI outright — whoever adds the portal has to widen it deliberately.
- Postgres is private. Correct.
- `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true` on all seven. This is the documented
  pilot compromise; OIDC removes it.

## What this means for trustos.cambobia.com

The domain can be attached and TLS will work. What it cannot do yet is _load a portal_,
because no portal exists. Three honest options, in the order I would take them:

1. **Attach the domain to `governance-tool` now.** The URL becomes real, TLS is verified, DNS
   is settled, and `https://trustos.cambobia.com/governance/apps` answers. The root returns a
   JSON 404 until a portal is added. Nothing is wasted and nothing is faked.
2. **Wait until a portal exists.** Cleanest first impression, but leaves the domain unclaimed
   and the DNS work undone.
3. **Build a portal.** Out of scope for this task, which says explicitly not to redesign the
   Governance Tool or invent modules to fill navigation. It is the right next piece of work,
   but it is a piece of work, not a routing change.
