# Environments and promotion

DEV, UAT, PROD — separate configurations, separate credentials, separate instances.

## The rule

**A lower-environment credential must never authenticate to production.**

Violated the same way every time: somebody copies a `.env` to debug something, the development
console starts answering with production data, and it _works_ — so nobody notices until an
export.

`assertNoCrossEnvironmentCredential` compares credential **references** (this layer never sees a
credential) and refuses a shared one **at load**. Not at first use: by first use it has already
worked once, and a thing that works is depended on by the afternoon.

## What is separate

|                         | DEV        | UAT        | PROD                  |
| ----------------------- | ---------- | ---------- | --------------------- |
| Resource registry       | own        | own        | own                   |
| Credential references   | own        | own        | own                   |
| Gateway instance        | own        | own        | own                   |
| Editable                | yes        | yes        | **no**                |
| Carries production data | no         | no         | yes                   |
| Promotion approvals     | operations | operations | security + operations |

Production is **not editable**. An internal application is promoted into production, not written
there — otherwise the reviewed artefact and the running one are different.

A non-production environment carrying production data is refused by the schema: if the data is
real, the environment is PROD with weaker controls.

## The environment is not `NODE_ENV`

`TRUSTOS_ENVIRONMENT` is its own variable. A UAT gateway runs with `NODE_ENV=production` — that
is what turns on production behaviour in the runtime — and conflating the two is how an instance
decides it is production when it is not.

It is **refused rather than defaulted**. A gateway defaulting to `dev` in a misconfigured
production deployment would serve production traffic under development rules.

## Promotion

```text
   DEV ──review──> UAT ──validation──> PROD
```

`planPromotion` produces a plan and refuses six things:

| Refusal                                    | Why                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| A skip (DEV → PROD)                        | The stage it skips is the one where somebody would have used it         |
| A demotion (PROD → UAT)                    | Replaces the running console with whatever was in the lower environment |
| An unregistered resource **in the target** | The commonest failure; checking the source reports it as fine           |
| No test evidence                           | —                                                                       |
| No security review (production)            | —                                                                       |
| No rollback target (production)            | A change with no way back, at the moment you most need one              |

The plan lists what would change, and the Governance Tool has **no route that applies one**.
Promotion into a higher environment is a deployment, not a button.

## Registering the consoles

`consoleCatalogFor(environment)` builds the ten templates for an environment. In production the
schema refuses a highly-restricted application that has never had a security review — so a
deployment records a real review date rather than inheriting a placeholder.
