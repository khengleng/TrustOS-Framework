# Unresolved issues and risk register

Everything found and not fixed, and what each would cost.

## Unresolved issues

### 1. Six high-severity dependency advisories

**Status: open. Fixes available for all six.**

| Package           | Direct | Fix                 |
| ----------------- | ------ | ------------------- |
| `prisma`          | yes    | `prisma@6.12.0`     |
| `@prisma/config`  | no     | via `prisma@6.12.0` |
| `deepmerge-ts`    | no     | via `prisma@6.12.0` |
| `brace-expansion` | no     | available           |
| `js-yaml`         | no     | available           |
| `nanoid`          | no     | available           |

Not applied during the pilot, deliberately: changing the dependency tree mid-run would have changed
what was being measured. First item in the remediation list.

### 2. `LimitDecision` cannot express "no limit applied"

**Status: open. Framework change required.**

`LimitStore.applicable` matches on `organizationId`. A limit registered against `null` does not
apply to a payment made by `org_a`, and the payment is _accepted_ — because no limit applied.

There is no error, no warning and no log line. A deployment that configures a platform-wide limit
while expecting a tenant limit ships a product with no limits and no signal.

**Cost if not fixed:** a product with no limits, discovered by a loss.

**Fix:** `LimitDecision` should report which limits were evaluated, so a decision that evaluated
zero is distinguishable from one that passed them all.

### 3. The simulator's scenario options are not reachable from the CLI

**Status: open. CLI change required.**

`scenarioMix`, `duplicateEvery` and `resetBalanceEvery` exist on `simulate()` and not on
`trustos financial-product simulate`, so the CLI can only run the all-success path — which the
simulator's own caveat describes as not being a reliability estimate.

The pilot's simulation evidence is produced by a test rather than a command as a result.

**Cost if not fixed:** anybody using the CLI for simulation evidence quotes a number the simulator
itself says is not one.

### 4. `WalletService.credit` posts a journal, and does not say so

**Status: open. Documentation change.**

An application that posts its own journal _and_ calls `credit` counts the money twice. The pilot did
this and was caught by a balance assertion — one it happened to write.

**Cost if not fixed:** a doubled balance in an application that trusts the call.

**Fix:** one sentence in the method's documentation.

### 5. `checkApproverEligibility` is hard to find outside a workflow

**Status: open. Documentation change.**

The pilot wrote its own eligibility check because the framework's lives in a package named for
workflows. It is usable standalone and takes plain arguments.

**Cost if not fixed:** every application writes its own, and each one is subtly different.

## Risk register

| #   | Risk                                                                        | Likelihood | Impact                                           | Current control                                                          | Residual                                         |
| --- | --------------------------------------------------------------------------- | ---------- | ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------ |
| R1  | A backup exists that cannot be restored                                     | —          | Total data loss                                  | **None — no backup exists**                                              | **Unmitigated**                                  |
| R2  | Recovery has never been rehearsed                                           | —          | Extended outage                                  | **None — no DR plan exists**                                             | **Unmitigated**                                  |
| R3  | A limit is configured at the wrong tenant scope and silently does nothing   | Medium     | Loss up to the unlimited exposure                | Pilot test coverage; no framework signal                                 | **High**                                         |
| R4  | A dependency advisory is exploited                                          | Low        | Varies                                           | Fixes available, unapplied                                               | Medium                                           |
| R5  | Production performance differs materially from the measurement              | **High**   | Capacity planning wrong                          | Measurement stated as in-process only                                    | Medium — accepted, measure again with a database |
| R6  | An application makes a merchant the tenant                                  | Medium     | Cross-merchant data leak with a green test suite | Documented in three places in this pack                                  | Medium                                           |
| R7  | A journal is posted twice through `credit`                                  | Medium     | Doubled balances                                 | Pilot balance assertion; no framework signal                             | Medium                                           |
| R8  | No identity provider is wired, so nothing authenticates                     | —          | No access control at all                         | Refusing default provider — the app cannot start authenticated           | Low — fails closed                               |
| R9  | A reviewer reads the per-transaction success rate as the reliability figure | Medium     | Overstated readiness                             | Both modes reported with what each measures                              | Low                                              |
| R10 | An AI feature is widened to take a ledger input                             | Low        | Restricted data in a model prompt                | Input allow-list per feature; classification refuses `HIGHLY_RESTRICTED` | Low                                              |

**R1 and R2 have no likelihood column** because they are not risks of something going wrong. They
are the current state: there is no backup and no rehearsed recovery, and both are FAIL on the
scorecard rather than risks to monitor.

**R8 is worth reading twice.** The pilot wires no identity provider, and the framework's default
authenticates nobody and throws on use. That fails closed, which is why the residual is low rather
than critical — an application that forgot to wire identity does not start serving unauthenticated
requests, it stops.

## Architectural problems discovered

**None in the framework's shape.**

That is the most useful sentence in this pack. After building a complete payment product on it, all
five framework issues found are discoverability problems — a decision that produces no signal, an
option not exposed through the CLI, three documentation gaps.

The one architectural decision the _pilot_ had to get right and could have got wrong is whether a
merchant is a tenant. It is not, and the reasoning is in
[`../architecture.md`](../architecture.md).
