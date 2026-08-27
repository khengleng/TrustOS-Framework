# Enterprise governance architecture

Phase 13 adds thirty packages across five domains, three applications and seventeen CLI commands.
This page is the map: what each domain is for, what it deliberately does not do, and where the
boundaries between them sit.

## The shape

```text
Data governance          What data exists, how sensitive it is, where it came from,
                         how long it is kept, and who may see it.

Policy-as-code           What the rules currently are, as versioned documents that
                         can be simulated, tested and re-derived.

SRE                      What runs, what it depends on, what "working" means for it,
                         and what happened when it stopped.

API management           Which APIs exist, who may call them, how fast, how much,
                         and what happens to callers when one is withdrawn.

Continuity               What has been backed up, what has been restored, what has
                         been rehearsed — and the gap between those and what was promised.
```

Each domain is independently useful. What makes them a layer rather than five libraries is that
they refer to each other by id: a business process names services, a service names dependencies, an
API names an implementing service, a DR plan names recovery procedures. Every one of those
references is checked, and an unresolvable one is a finding rather than a silent null.

## What lives where

| Question                                 | Package                        |
| ---------------------------------------- | ------------------------------ |
| How sensitive is this?                   | `@trustos/data-classification` |
| What data exists?                        | `@trustos/data-catalog`        |
| Where did it come from?                  | `@trustos/data-lineage`        |
| How long do we keep it?                  | `@trustos/data-retention`      |
| How is it masked?                        | `@trustos/data-masking`        |
| Who may see it, and why?                 | `@trustos/data-access-policy`  |
| What is wrong with our data governance?  | `@trustos/data-governance`     |
| What are the rules?                      | `@trustos/policy-registry`     |
| What does this rule decide?              | `@trustos/policy-evaluator`    |
| What did we decide, and can we prove it? | `@trustos/policy-decision-log` |
| Decide, enforce, record                  | `@trustos/policy-engine`       |
| What runs, and who owns it?              | `@trustos/sre-core`            |
| What are we measuring?                   | `@trustos/sli`                 |
| What counts as working?                  | `@trustos/slo`                 |
| Is it working right now?                 | `@trustos/dependency-health`   |
| What happened when it stopped?           | `@trustos/incident-management` |
| What happens when a dependency fails?    | `@trustos/resilience`          |
| Which APIs exist?                        | `@trustos/api-catalog`         |
| What changed between versions?           | `@trustos/api-versioning`      |
| Who may call what?                       | `@trustos/api-consumer`        |
| How fast?                                | `@trustos/api-rate-limit`      |
| How much?                                | `@trustos/api-quota`           |
| What else does this deployment require?  | `@trustos/api-policy`          |
| What may a developer see?                | `@trustos/developer-access`    |
| All of it, in order                      | `@trustos/api-management`      |
| What is backed up?                       | `@trustos/backup`              |
| Has it ever been restored?               | `@trustos/recovery`            |
| What is the plan?                        | `@trustos/disaster-recovery`   |
| Does the plan meet the promise?          | `@trustos/continuity`          |
| What breaks when we break it on purpose? | `@trustos/resilience-testing`  |

## Four positions that shape everything

These recur across all five domains. They are not stylistic; each one is a specific failure the
layer is designed to make impossible rather than discouraged.

### Absence of evidence is reported as absence, never as success

An unobserved SLI window reports `null`, not 100%. A dependency nobody probed recently reads
`UNKNOWN`, not healthy. A backup nobody restored from is a hypothesis, not a validated backup. A DR
plan exercised as a tabletop is documented, not demonstrated. A `trustos enterprise doctor` check
with no input is _skipped_, not passed.

Every one of those would be greener the other way, and every one would be lying. The failure this
prevents is specific and common: a dashboard that renders a monitoring outage as a healthy estate,
which is exactly backwards — the moment you can no longer see is the moment to be most concerned.

### Configuration can refuse; only code can permit

`@trustos/api-policy` and `@trustos/policy-engine` both expose adapters into `@trustos/authorization`
that return a refusal or abstain. Neither can return an allow.

This is what makes a configurable policy layer safe. A document policy that could grant would let
somebody widen access past a code refusal by editing configuration, and the whole default-deny
structure would then depend on nobody writing an over-broad document.

The floor stays in code — status, environment, entitlement, version, scope — and it is the same on
every deployment.

### Proposing and doing are different permissions held by different people

Classification changes, policy activation, reveals, DR activation and production experiments all
split into a proposer and an approver. The split is declared per application in `SEGREGATED_PAIRS`
and tested.

The subtlety is that the collapse is invisible in a role definition. A role holding both halves
looks like somebody being given the permissions they need to do their job.

### An audit trail is not a log

Every consequential action in this layer lands in `@trustos/audit`, which is persistent and
append-only. Everything else — the registries, the catalogs, the decision log sink in the example
applications — is in memory and says so at start-up.

That asymmetry is deliberate. A registry that does not survive a restart is an inconvenience. An
audit trail that does not survive a restart is a compliance failure, and the difference is worth
building the applications around.

## What phase 13 does not add

No Prisma models. A catalog entry, a policy document, a service registration, a DR plan and a
business process are all _documents_, and which shape they take in a database is a decision a
deployment makes against its own retention, replication and access rules. The framework ships the
schemas, the invariants and the ports; a deployment binds storage.

The one extension to the schema is the one phase 12 made: `AuditLog.metadata`, so provenance has
somewhere to go that is not `after`.

No provider integrations, no country-specific rules, no vendor SDKs. The layer is provider-neutral
throughout — see `docs/provider-abstraction.md`.

## Reading order

New to the layer: [`operating-model.md`](operating-model.md), then
[`../data-governance/classification.md`](../data-governance/classification.md), then
[`../policy/architecture.md`](../policy/architecture.md).

Running it: [`../sre/slo.md`](../sre/slo.md) and
[`../sre/incident-management.md`](../sre/incident-management.md).

Proving it: [`../disaster-recovery/backup.md`](../disaster-recovery/backup.md) and
[`../disaster-recovery/restore.md`](../disaster-recovery/restore.md).
