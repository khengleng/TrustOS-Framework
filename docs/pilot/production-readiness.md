# Production readiness scorecard

Fourteen categories. **PASS requires an evidence reference**, and a category with no evidence is
FAIL rather than PARTIAL — the specification is explicit, and the distinction matters most exactly
where it is least comfortable.

## The scorecard

| Category            | Score       | Evidence                                                                                                                                 |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture        | **PASS**    | [`architecture.md`](architecture.md); `npx trustos architecture-check` clean across 973 files                                            |
| Security            | **PARTIAL** | [`evidence/security-results.md`](evidence/security-results.md) — 34 negative tests pass; 6 dependency advisories open                    |
| Identity            | **PARTIAL** | Framework provides it; the pilot authenticates nobody — no identity provider is wired                                                    |
| Tenant isolation    | **PASS**    | [`evidence/tenant-isolation.md`](evidence/tenant-isolation.md) — 11 tests against the service, not the UI                                |
| Financial integrity | **PASS**    | [`evidence/financial-integrity.md`](evidence/financial-integrity.md) — balance derives from the ledger; no journal for a refused payment |
| Workflow            | **PASS**    | [`evidence/maker-checker.md`](evidence/maker-checker.md) — three distinct people, self-approval refused twice over                       |
| Data governance     | **PASS**    | [`evidence/data-governance.md`](evidence/data-governance.md) — six entities classified, obligations derived                              |
| API management      | **PASS**    | [`evidence/api-tests.md`](evidence/api-tests.md) — catalog, entitlement, rate, quota, all refusing                                       |
| Observability       | **PARTIAL** | Correlation ids propagate and are audited; no metrics backend, no traces, no dashboard                                                   |
| Performance         | **PARTIAL** | [`evidence/performance-results.json`](evidence/performance-results.json) — measured, in-process only                                     |
| Backup              | **FAIL**    | **Not performed.** No database exists to back up                                                                                         |
| DR                  | **FAIL**    | **Not performed.** No deployment exists to fail over                                                                                     |
| Documentation       | **PASS**    | This pack, plus 20 framework documents added in phase 13                                                                                 |
| Operations          | **PARTIAL** | Service registered, runbook written, objective defined — none exercised against a running system                                         |

**5 PASS · 6 PARTIAL · 2 FAIL · 1 not applicable**

## Why each score

### Architecture — PASS

The pilot composes 60 framework packages and adds 1,585 lines. `architecture-check` enforces
declared-dependencies-only, no deep imports and the layering rules, and passes. No framework
capability was duplicated.

_Evidence:_ [`framework-reuse-report.md`](framework-reuse-report.md),
[`evidence/framework-reuse.json`](evidence/framework-reuse.json).

### Security — PARTIAL

34 negative tests pass, covering every item the pilot specification lists: authorization bypass,
role escalation, cross-tenant access, IDOR, replay, duplicate transactions, idempotency bypass,
self-approval, ledger tampering, audit deletion, PII exposure, credential scope misuse.

**Why not PASS:** six high-severity dependency advisories are open, one of them direct. All have
fixes available and none has been applied, because applying them mid-pilot would have changed what
the pilot was measuring. They are remediation, not findings to argue about.

There has been no penetration test and no external review.

_Evidence:_ [`evidence/security-results.md`](evidence/security-results.md),
[`evidence/dependency-audit.json`](evidence/dependency-audit.json).

### Identity — PARTIAL

The framework provides local and OIDC providers, MFA assurance, session security and API keys. The
pilot wires none of them: it runs in-process and its actors are strings.

**Why not FAIL:** the capability exists, is tested in the framework and is used by three
applications in this repository. **Why not PASS:** this pilot did not exercise it, and a scorecard
that credited the pilot for a framework test would be crediting the wrong thing.

### Tenant isolation — PASS

Eleven tests, every one against the service rather than a UI, per the specification's instruction
to test API manipulation directly. Organization A cannot read B's merchant, wallet, journal or
audit record; a platform-wide role does not cross a tenant boundary; a cross-tenant read answers
404 rather than 403.

_Evidence:_ [`evidence/tenant-isolation.md`](evidence/tenant-isolation.md).

### Financial integrity — PASS

The wallet balance is derived from the ledger and equals the sum of the payments' net amounts to
the minor unit. No journal is posted for a refused payment. An unbalanced journal is refused. There
is no `update` or `delete` on the ledger. No float appears on the payment path.

_Evidence:_ [`evidence/financial-integrity.md`](evidence/financial-integrity.md).

### Workflow — PASS

Merchant onboarding requires three distinct people. The approver may be neither the verifier nor
the registrar — the second exclusion matters, because a control excluding only the immediately
preceding actor is satisfied by one person registering, a second verifying and the first approving.
A limit change is a request that changes nothing until approved by somebody other than the
requester. Rejection requires a reason and, where rework is permitted, a remediation.

_Evidence:_ [`evidence/maker-checker.md`](evidence/maker-checker.md).

### Data governance — PASS

Six entities classified at the levels the specification names. Masking, export, reveal-approval and
AI-input permission are all _derived_ from the classification rather than declared per field. The
catalog's inheritance check would catch a table classified below its own columns.

_Evidence:_ [`evidence/data-governance.md`](evidence/data-governance.md).

### API management — PASS

The pilot API is registered with two owners, a derived classification, an OpenAPI reference and an
objective. The gate refuses in five distinct places with distinct codes. Rate and quota are
separate and refuse separately.

_Evidence:_ [`evidence/api-tests.md`](evidence/api-tests.md).

### Observability — PARTIAL

Correlation ids propagate from the request through the payment engine into the ledger metadata and
the audit record, and a test asserts it. The framework's metrics and tracing seams exist and cost
nothing until a backend is adopted.

**Why not PASS:** no backend is adopted, so there are no metrics, no traces and no dashboard. The
seam being present is not the same as the system being observable, and this pilot cannot show a
trace because nothing collects one.

### Performance — PARTIAL

Measured at three concurrency levels with zero errors: 6,512/s at 10 users, 10,605/s at 50, 9,257/s
at 100, with p95 of 1.28ms, 5.56ms and 16.32ms.

**Why not PASS:** it measures the pilot's payment path in one process against in-memory stores. No
HTTP, no database, no network. A production p95 will be larger by an amount dominated by exactly
the two things excluded, so these numbers say the application logic is not the bottleneck and say
nothing else.

_Evidence:_ [`evidence/performance-results.json`](evidence/performance-results.json).

### Backup — FAIL

**Not performed.** There is no database in this pilot, so there was nothing to back up.

This is FAIL and not PARTIAL. `@trustos/backup` requires four independent claims before a backup is
`fullyValidated` — completed, checksummed, inspected, restored from — and this pilot can make none
of them. Scoring it PARTIAL on the strength of the framework having a backup package would be
exactly the rounding-up the framework's own `describeAssurance` was written to prevent.

### DR — FAIL

**Not performed.** No deployment exists to fail over.

`capabilityStatement` in `@trustos/disaster-recovery` would report _"No region-failure plan exists.
Multi-region recovery is not a capability this platform has."_ That sentence is the honest one and
it is the one this scorecard carries.

### Documentation — PASS

This pack, the 20 documents added in phase 13, and the framework's existing set. Every package the
pilot uses has a header explaining what it refuses and why.

### Operations — PARTIAL

A service is registered with an owner, a rotation and a runbook. An indicator and an objective are
defined, and the error budget is calculated from the simulation's actual numbers — which shows the
budget _exhausted_, correctly, because 1,378 failures against a 99.9% target permitting 98 is a
missed objective.

**Why not PASS:** nothing has been operated. No incident has been declared against a running
system, no alert has fired, no runbook has been followed.

## Remediation before the next pilot

In order of what should be done first.

1. **Apply the six dependency fixes** and re-run `npm audit`. All six have fixes available.
2. **Bind a database and re-run the pilot against it.** Every port has a Prisma implementation. The
   numbers that change are the ones that matter, and until they change nothing here is a
   performance measurement.
3. **Take a backup, verify it and restore from it.** Then record the restore test, which moves
   Backup from FAIL to a real score.
4. **Wire an identity provider.** Until then, Identity is a framework capability the pilot has not
   used.
5. **Adopt a metrics backend.** The seam is one adapter; without it, Observability cannot move.
6. **Run a DR exercise**, even a tabletop — and record it as a tabletop, which is documented rather
   than demonstrated.

## The gate

**GO for the next pilot.** The framework produced a complete, tested, governed payment product with
85.6% reuse on the payment path and no duplicated capability, and the six issues found are
discoverability problems rather than design ones.

**NOT go for production banking use**, and the two FAIL scores are the reason rather than a caveat.
A platform whose backup has never been restored and whose recovery has never been rehearsed is not
a platform to put customer money on, however good the rest of the scorecard looks. That is the
position `@trustos/backup` and `@trustos/disaster-recovery` were written to force, and it would be
incoherent to build those packages and then round up in the first report that uses them.
