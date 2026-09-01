# TrustOS v0.1 — system validation gate

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| **Overall** | **TRUSTOS v0.1 PARTIALLY READY**                           |
| Commit      | `c7cb557182b5afc78ad6e656e072d1540ef45ca8`                 |
| Branch      | `foundation/phase-1` (not merged to `main`)                |
| Environment | DEV — https://governance-tool-dev.up.railway.app           |
| Artifact    | none — each environment builds its own image (see TOS-007) |
| Identity    | https://id.cambobia.com, realm `trustos-dev`, mode `oidc`  |
| Generated   | 2026-08-29                                                 |

## Scorecard

| Gate                           | Result          | Why                                                                                                                            |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **1 — Core foundation**        | **PARTIAL**     | Six controls PASS. Authentication's positive deployed path is unreachable: the DEV validation client is still public (TOS-003) |
| **2 — Deployed boundary**      | **NOT_REACHED** | Requires a machine token from gate 1. Below-HTTP evidence cannot satisfy it, and is not offered as if it could                 |
| **3 — Security / adversarial** | **PASS**        | 49/49. No critical or high finding open against the tested boundary                                                            |
| **4 — Recovery / resilience**  | **PARTIAL**     | 20/21. Logical backup and restore proven; no platform snapshot exercised (TOS-008)                                             |
| **5 — UAT readiness**          | **PARTIAL**     | Environments are isolated and a plan exists, but promotion is manual and PROD deploys on merge (TOS-006, TOS-007)              |

No gate compensates for another. Gate 2 is NOT_REACHED rather than PARTIAL because
nothing about the deployed authenticated boundary was observed at all.

## Regression

|                              |                                      |
| ---------------------------- | ------------------------------------ |
| Tests                        | **5,740 / 5,740**, 0 failing         |
| Lint                         | **0 errors**                         |
| Build / typecheck            | **exit 0**                           |
| Foundation validator         | **24 / 24 PASS** (real DEV database) |
| Approval Workbench validator | **33 / 33 PASS** (real DEV database) |
| Adversarial validator        | **49 / 49 PASS**                     |
| Recovery validator           | **20 / 21**, 1 SKIP                  |
| CI                           | success, 11/11 jobs                  |

## Gate 1 — foundation

| Control        | Result      | Evidence                                                                    |
| -------------- | ----------- | --------------------------------------------------------------------------- |
| Authentication | **PARTIAL** | Negative path proven deployed; positive path NOT_REACHED                    |
| Multi-tenancy  | PASS        | 5 checks, both directions, foreign checker refused at the engine            |
| RBAC           | PASS        | maker refused, viewer refused, checker allowed                              |
| Policy         | PASS        | every refusal emitted a security event naming its reason                    |
| Workflow       | PASS        | five states persisted; version pinned across restart                        |
| Maker-checker  | PASS        | `self_approval_forbidden` at the check and in the event stream              |
| Audit          | PASS        | trail enumerated, tenant-scoped, append-only enforced by a database trigger |

### The negative evidence model, corrected

Earlier negative results were inferred from timing and the inference was wrong. The
provider now reports which layer refused a token, read from jose's error code and claim.
Layers are ordered, and a token is refused at the **first** check it fails — so a later
check cannot be claimed by a token that fails an earlier one.

Measured against deployed DEV:

| Case            | Intended layer | Observed layer     | Verdict           |
| --------------- | -------------- | ------------------ | ----------------- |
| anonymous       | guard          | guard              | proven            |
| not a JWT       | format         | format             | proven            |
| unpublished kid | key_resolution | key_resolution     | proven            |
| expired         | expiry         | **key_resolution** | **not exercised** |
| wrong issuer    | issuer         | **key_resolution** | **not exercised** |
| wrong audience  | audience       | **key_resolution** | **not exercised** |

The last three are now known — by measurement, not inference — not to have tested what
they appear to. Reaching those checks requires a token with a valid signature, which
requires the realm's private key. They are covered instead at **cryptographic-integration
level** by ten tests that each fail exactly one check with everything before it correct.
That evidence is explicitly labelled and is not promoted to deployed evidence.

### Readiness

`/ready` reports `identity: ok — token verification available`, disclosing no issuer,
key state or counters. Forty invalid tokens across four kinds left it healthy; genuine
key-retrieval failure degrades it and one successful verification clears it.

## Gate 2 — deployed boundary

**NOT_REACHED.** Every step needs a token the DEV realm cannot currently issue.

What _is_ proven deployed, without a credential: all five workbench routes refuse
anonymous access with 401 — distinct from 404 for a non-route, so the routes are mounted
and the guard is executing; hostile identifiers, oversized and malformed bodies produce
no 500 and no disclosure; security headers are present on error responses.

What is not proven: that authentication middleware admits a valid token, that tenant
resolution and authorization decorators execute on an authenticated request, or that the
full chain from Keycloak to Postgres works end to end.

## Gate 3 — security

49/49. Notable results:

| Attack                                          | Result                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Tenant override in query or body                | refused by strict schema; no store call left the actor's tenant |
| Forged `isSuperAdmin` on the actor              | scope unchanged                                                 |
| Actor / role override in a decision             | refused                                                         |
| Cross-tenant read by id                         | **not_found**, never forbidden                                  |
| Prototype pollution in a body                   | did not alter the running process                               |
| 2MB body                                        | 413, not parsed                                                 |
| Path traversal, null byte, CRLF, 6KB identifier | refused, no 500, no header injection                            |
| Method override header                          | not honoured                                                    |
| CORS from an unapproved origin                  | no `Access-Control-Allow-Origin`                                |

Secret scan of the branch: clean. The only matches are a variable _name_ in
documentation, two test-fixture passwords, and a JWT fixture decoding to
`{"sub":"forged"}` with a literal `not-a-signature`.

Rate limiting exists in policy (`login`, `refresh`, `apiKeyAuth` and others) but was not
exercised on the workbench boundary, which sits behind authentication that could not be
completed. Recorded as a gap rather than a pass.

## Gate 4 — recovery

| Property                               | Result                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Database read failure                  | refuses; does not return an empty result                                                           |
| Database write failure during approval | request stays in review; no false success                                                          |
| Impossible state                       | none — every approved instance had a decision                                                      |
| Retry after failed write               | converges to approved with one decision, not two                                                   |
| Identity unreachable                   | refuses; no fallback to local authentication                                                       |
| Readiness on key-retrieval failure     | degrades, then clears after one success                                                            |
| Restart                                | instance, version pin, decisions and pending tasks all survive                                     |
| Backup / restore                       | 30 rows restored into an isolated schema, verified table by table and read back through the domain |

Measured: backup 850–1052ms, restore 2318–3208ms. **These are measurements, not an RTO.**

## Gate 5 — UAT readiness

Environments are genuinely isolated — three separate databases on different hosts, three
distinct JWT signing secrets (verified by fingerprint, never by value).

What blocks PASS: promotion is manual, there is no immutable artifact (TOS-007), and
merging to `main` deploys PROD directly through Railway's GitHub integration with no
approval gate (TOS-006). UAT was deliberately not modified.

### UAT requirements, prepared and not applied

- `trustos-uat` realm: its own machine validation client, then a browser client
- UAT-specific secrets — **never** DEV's
- UAT points at its own realm — **never** `trustos-dev`
- UAT keeps its own database, domains, evidence and backup

## Observability

A caller-supplied `X-Request-Id` is echoed in the response header, carried in the error
body, and appears in structured logs. At the domain level a correlation id reached all
three audit records for one approval, the decision carried its `policyDecisionId`, and
every audit record named an actor or the system.

The chain is unbroken except through the authenticated HTTP segment, which gate 2 blocks.

## PROD

**Untouched and verified so at the end of this work.** `IDENTITY_PROVIDER=oidc`, issuer
`.../realms/trustos`, `https://trustos.cambobia.com/health` → 200. Not deployed, not
merged to. `TRUSTOS_ENVIRONMENT=dev` on production remains open as TOS-001 and was
deliberately not fixed here.

## Application registry

| Application        | Validation             | Lifecycle |
| ------------------ | ---------------------- | --------- |
| Approval Workbench | **PASS (DEV)** — 33/33 | draft     |
| Everything else    | not_tested             | draft     |

Evidence does not cross environments: a DEV pass answers `not_tested` when the catalog is
asked about UAT or PROD.
