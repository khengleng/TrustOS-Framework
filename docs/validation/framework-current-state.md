# TrustOS Framework — current state

What this framework actually does, on 2026-08-29, with the evidence for each claim.

Generated from `npm run validate`, which counts source files, counts the tests that execute
against them, and probes a running deployment. Nothing here is classified from a menu, a
route, a table or a paragraph of documentation.

## The finding that reframes everything else

**The eleven "registered applications" in the Governance Tool are descriptors, not
applications.**

They are `InternalApplication` documents — declarations of what a console would contain:
pages, components, data sources, actions, owners, classifications. The portal renders those
declarations. No frontend, backend, route or database table implements any of them. The
codebase states this plainly:

> They are **internal application definitions**, which is data, rather than generator
> templates under `templates/`… A console is not an application to be scaffolded; it is a
> document the Governance Tool runtime executes.
>
> — `packages/governance-tool-core/src/consoles.ts`

A directory search for implementing code finds none for any of the eleven. Two names collide
with unrelated things: `apps/sre-operations-console` is the SRE backend, and
`packages/case-management` is a domain package — neither implements the console of a similar
name.

This is not a defect. It is what the Governance Tool is _for_, and it is the framework's
Frappe-Desk equivalent: a console is declared and rendered rather than written. But it means
"eleven applications are registered" must not be read as "eleven applications work". Their
lifecycle of `draft` is accurate and should not be promoted.

## Capability classification

`IMPLEMENTED` here means: source exists, specs exist, and at least ten tests execute against
it and pass. `STUB` means code with no executing tests — an honest label, not an insult.

| Capability                          | Status      | Tests | Source / Spec files |
| ----------------------------------- | ----------- | ----: | ------------------- |
| Identity **(critical)**             | IMPLEMENTED |    57 | 14 / 2              |
| Multi-tenancy **(critical)**        | IMPLEMENTED |    34 | 7 / 2               |
| RBAC **(critical)**                 | IMPLEMENTED |    26 | 7 / 2               |
| Authorization **(critical)**        | IMPLEMENTED |    30 | 8 / 1               |
| Audit **(critical)**                | IMPLEMENTED |    16 | 6 / 1               |
| Financial primitives **(critical)** | IMPLEMENTED |   184 | 16 / 5              |
| Security controls **(critical)**    | IMPLEMENTED |    98 | 13 / 3              |
| Workflow                            | IMPLEMENTED |   165 | 23 / 4              |
| Maker-checker                       | IMPLEMENTED |    64 | 4 / 2               |
| Policy engine                       | IMPLEMENTED |    48 | 6 / 3               |
| Case management                     | IMPLEMENTED |    33 | 3 / 1               |
| AI gateway                          | IMPLEMENTED |   115 | 8 / 3               |
| Financial product layer             | IMPLEMENTED |    83 | 13 / 3              |
| API management                      | IMPLEMENTED |    86 | 8 / 4               |
| Data governance                     | IMPLEMENTED |    71 | 8 / 4               |
| Observability                       | IMPLEMENTED |    14 | 6 / 1               |
| Backup                              | IMPLEMENTED |    20 | 2 / 1               |
| Restore                             | IMPLEMENTED |    20 | 2 / 1               |
| Governance Tool                     | IMPLEMENTED |    43 | 6 / 1               |
| CLI and generator                   | IMPLEMENTED |   408 | 37 / 15             |

Totals: **5,663 tests across 1,510 suites, all passing**, over 193 packages.

### What "IMPLEMENTED" does and does not mean here

These are in-process tests. They execute the real code — the real ledger, the real guards, the
real workflow engine — but they run in a test harness, not against a deployed service over
HTTP. That distinction is the difference between "the authorization logic refuses this" and
"the deployed system refuses this", and both matter.

The deployment probe below covers the second for the surface that is deployed.

## Deployed state — Railway DEV

`npm run validate -- --deployed --base-url https://governance-tool-dev.up.railway.app`

| Check                             | Result                                |
| --------------------------------- | ------------------------------------- |
| `GET /health`                     | 200                                   |
| `GET /ready`                      | 200, database check passing           |
| Health discloses no credentials   | pass                                  |
| Protected route refuses anonymous | 401                                   |
| Forged bearer token refused       | 401                                   |
| HSTS                              | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options`          | `nosniff`                             |
| `X-Frame-Options`                 | `DENY`                                |
| Content-Security-Policy           | `default-src 'none'`…                 |
| CORS refuses an unapproved origin | pass — no header returned             |

## Gaps, stated plainly

These are not classified failures; they are things that do not exist yet and are load-bearing
for anything built on this framework.

**No `AccessResolver` implementation exists.** Every application ships
`refusingIdentityProvider()` and a resolver that returns null. The consequence is concrete: a
user holding `operator` or `auditor` authenticates successfully and is then refused, because
organization membership never resolves. Only `isSuperAdmin` — granted through the identity
provider's role mapping — reaches anything. Delegation below platform-root is therefore not
possible today.

**No link exists from an OIDC subject to a framework `User`.** `ServiceAccount` carries
`oidcClientId` for machine identities; `User` has no equivalent column. A person who signs in
through Keycloak has no row in the framework's own user tables, so the organization and
membership model is unused.

**One deployed service is a demonstration.** `trustos-api` runs `apps/api-example`, described
in its own manifest as a _"Reference NestJS API demonstrating every TrustOS framework
package"_. It is also the last service still on `IDENTITY_PROVIDER=local`.

**Console applications have no runtime.** Covered above.

**`TRUSTOS_ENVIRONMENT` is `dev` in the environment named `production`.** Accurate as a
statement about readiness, confusing as a label now that a real `dev` environment exists.

## Environment parity

|                   | production                | dev             | uat             |
| ----------------- | ------------------------- | --------------- | --------------- |
| Code              | current                   | current         | current         |
| Portal            | serving                   | serving         | serving         |
| Identity provider | OIDC on `governance-tool` | none configured | none configured |
| Realm             | `trustos`                 | not created     | not created     |
| Database          | own                       | own             | own             |
| Signing secrets   | distinct                  | distinct        | distinct        |

Dev and UAT run the same code as production and answer `/health`, `/ready` and the portal.
Neither has an identity provider, so neither can be signed into. A promotion path exists for
code and not yet for identity.

## Method

- Capability inventory and classification: `scripts/validate.mjs`, from file counts and
  executed test results
- Test evidence: `npx vitest run --reporter=json`, 5,663 assertions
- Deployment evidence: live HTTP probes against Railway DEV
- Machine-readable output: `docs/validation/latest.json`
