# Security test results

34 tests in `apps/merchant-wallet-basic/src/security.spec.ts`, all passing, every one negative.

Each asserts a bypass is **refused**, and each is written against the service rather than a UI —
the pilot specification is explicit about that, and the reason is that a hidden button is a request
anybody can still make with curl.

## What was tested

| Attack                | Result            | How it is refused                                                                                       |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| Authentication bypass | Not tested here   | No identity provider is wired; the framework's own suite covers it                                      |
| Authorization bypass  | **Refused**       | Role permission maps; `auditor` holds no write permission at all                                        |
| Role escalation       | **Refused**       | No role holds both halves of a maker-checker pair                                                       |
| Cross-tenant access   | **Refused**       | `organizationId` first and non-optional on every read                                                   |
| IDOR                  | **Refused**       | A merchant id alone is not authorization; a payment naming another tenant's merchant is not found       |
| API key misuse        | **Refused**       | `scopeSatisfies` — write covers read, never the reverse; a scope on one resource does not reach another |
| Replay                | **Refused**       | Idempotency on the merchant's own reference                                                             |
| Duplicate transaction | **Refused**       | Eight concurrent identical requests produce one journal                                                 |
| Idempotency bypass    | **Refused**       | A different tenant cannot replay another's reference; the key is tenant-scoped                          |
| Self-approval         | **Refused twice** | The approver may be neither the verifier nor the registrar                                              |
| Ledger tampering      | **Refused**       | No `update`, no `delete`; an unbalanced journal is refused; no journal for a refused payment            |
| Audit deletion        | **Refused**       | The audit service has no delete, no update and no clear                                                 |
| PII exposure          | **Refused**       | No amount or balance on the merchant record; no amount in the approval audit metadata                   |
| Sensitive export      | **Refused**       | `HIGHLY_RESTRICTED` is not exportable — derived from the classification                                 |
| Invalid token         | Not tested here   | No identity provider is wired                                                                           |
| Expired token         | Not tested here   | No identity provider is wired                                                                           |
| Wrong tenant          | **Refused**       | Eleven tests; see [`tenant-isolation.md`](tenant-isolation.md)                                          |

Three rows say "not tested here" rather than passing quietly. The pilot wires no identity provider,
so it cannot present an invalid token to anything. Marking those as passing on the strength of the
framework's own tests would credit this pilot for work it did not do.

## The two findings the tests produced about the pilot itself

Both were the pilot's own tests failing against the pilot's own code.

**The `finance` role was documented as read-only and holds `LIMIT_APPROVE_CHANGE`.** Approving a
limit change is a write — it raises a fraud control. `capabilityMatchesGrant` compares each role's
declared capability against the permissions it actually holds, and caught the row claiming
otherwise. Corrected.

**An audit assertion reached for the in-memory sink's `clear()`.** That method exists because a
test double which could not be reset would leak between suites. The claim belongs on the _service_,
which has no delete, no update and no clear — so no application code path reaches one. Corrected.

## Dependency security

`npm audit`, captured in [`dependency-audit.json`](dependency-audit.json):

| Package           | Severity | Direct  | Fix available       |
| ----------------- | -------- | ------- | ------------------- |
| `prisma`          | high     | **yes** | `prisma@6.12.0`     |
| `@prisma/config`  | high     | no      | via `prisma@6.12.0` |
| `deepmerge-ts`    | high     | no      | via `prisma@6.12.0` |
| `brace-expansion` | high     | no      | yes                 |
| `js-yaml`         | high     | no      | yes                 |
| `nanoid`          | high     | no      | yes                 |

**6 high, 0 critical, 0 moderate, 0 low**, across 973 dependencies.

All six have fixes available. **None has been applied**, deliberately: applying them mid-pilot would
have changed what the pilot was measuring. They are the first item in the readiness remediation
list.

Do not read this as "6 vulnerabilities". Five are transitive through Prisma's own dependency tree,
and `js-yaml` and `brace-expansion` reach the tree through build tooling rather than the runtime.
What is true is that a `npm audit` on this repository today reports six high-severity advisories,
and that is what the scorecard carries.

## Secret scanning

A pattern scan across `packages/`, `apps/` and `templates/` for assignments of key-, secret-,
password- or token-shaped names to literals of sixteen characters or more found **no hardcoded
secrets**. The three matches are variable assignments from function calls, not literals.

The framework's own controls are stronger than this scan: `@trustos/config` refuses to start
without required secrets, `redactSecrets` covers every logged configuration, and the audit trail
redacts before writing.

## Lockfile

`package-lock.json` is present, 12,753 lines, and `npm ls --depth=0` resolves cleanly.

## Static analysis

`npm run lint` — 0 errors, 44 warnings (all `no-console` in CLI output paths and bootstrap failure
handlers, where console output is the point).

`npx trustos architecture-check` — clean across 973 files: declared dependencies only, no deep
imports, layering respected.

## What was not tested

Stated rather than silently absent.

- **Transport security.** TLS, certificate handling, HSTS. Deployment concerns; this process
  cannot observe them.
- **Penetration testing.** None performed. No external review.
- **Fuzzing.** None performed.
- **Denial of service.** The rate limiter and quota were tested for correctness, not under load.
- **Supply chain beyond `npm audit`.** No SBOM, no provenance verification.
