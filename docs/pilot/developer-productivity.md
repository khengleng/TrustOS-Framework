# Developer productivity report

What the pilot cost to build, what the framework got wrong, and what should change as a result.

The specification says this report determines what TrustOS improves next, so it is written to be
actionable rather than flattering. Every item below is something that actually happened during the
build.

## What took time

| Step                            | Measured          | Note                                                     |
| ------------------------------- | ----------------- | -------------------------------------------------------- |
| Generate the product definition | **0.34s**         | `trustos financial-product create merchant-wallet-basic` |
| Validate it                     | under a second    | Two warnings, both correct — no connector bound          |
| First successful build          | —                 | `tsc` clean after the errors listed below                |
| Full test suite, 153 tests      | **~2s**           | Excluding the 100,000-transaction simulation             |
| 100,000-transaction simulation  | **7.5s**          | Deterministic, seed 1                                    |
| Deploy                          | **not attempted** | Deployment readiness is a separate phase                 |

The generation step is not the interesting number. A template that produces a valid product
definition in a third of a second is useful, and it is not what a pilot measures: what matters is
how much was still left to write afterwards, which is the 1,849 lines in the reuse report.

## Framework issues discovered

These are ordered by how much they would cost somebody who hit them without a pilot to catch it.

### 1. Limits are tenant-scoped, and silently do nothing when they are not

**Severity: high.** `LimitStore.applicable` matches on `organizationId`. A limit registered against
`null` does not apply to a payment made by `org_a` — and the payment is _accepted_, because no
limit applied.

The pilot's first run configured limits at `null` and every limit test failed with the limit
apparently absent. In a deployment that mistake produces no error, no warning and no log line: it
produces a product with no limits.

**What should change:** `LimitEngine.check` should report _which_ limits it evaluated, and a
decision that evaluated zero limits should be distinguishable from one that passed them all. The
current `LimitDecision` cannot express "no limit applied", so the caller cannot tell.

### 2. `@trustos/workflow-approvals` is hard to find from outside a workflow

**Severity: medium.** The pilot wrote its own approver-eligibility check because the framework's
lives in a package named for workflows, and the pilot's approval is not a workflow step.

`checkApproverEligibility` takes plain arguments and returns a verdict — it is exactly what was
wanted. It was found after the code was written.

**What should change:** documentation. `docs/maker-checker.md` should state that the eligibility
check is usable without a workflow instance, with the two-line example.

### 3. `WalletService.credit` posts its own journal

**Severity: medium — a correctness trap.** The wallet's balance is derived from the ledger, and
`credit` posts a two-entry journal. An application that posts its own journal _and_ calls `credit`
counts the money twice.

The pilot did exactly that in its first version. It was caught by a balance assertion, but only
because the pilot asserted the balance against the payment totals — an application that trusted the
credit call would ship it.

**What should change:** the `credit` documentation says it takes the counter-account explicitly and
explains why. It does not say that it posts. One sentence — "this posts a journal; do not post one
yourself" — would have prevented it.

### 4. A console could not name an AI feature

**Severity: medium — two packages that were meant to reference each other could not.**

`internalApplicationSchema.aiFeatures` required `[a-z][a-z0-9-]{2,59}` — kebab-case. Every feature
in `@trustos/governance-ai-bridge` is named `summarize_case`, `explain_policy` and so on —
snake_case.

So a console declaring the AI features it offers could not name one of them, and the mismatch was
invisible until something tried. Both packages ship in phase 12 and neither test exercises the
other's naming.

**Fixed during the pilot.** The pattern now accepts underscores, with a comment saying why. The
names are deliberately not validated against the bridge's list, because `governance-tool-core` must
not depend on the AI platform — a console naming a feature that does not exist is caught by the
runtime that resolves it.

### 5. A sandbox scenario with no `atBlock` fires at the first block

**Severity: low, and correct behaviour.** Injecting `settlement_failure` without naming a block
fails the run at `verify-merchant`, because that is the first block that could produce a generic
failure. The test then asserts something about settlement that never ran.

**What should change:** `runSandbox` could warn when an injection names a scenario whose usual
block is not the one it fired at. The `unfiredScenarios` field already reports the opposite case.

### 6. The simulator's default is per-transaction, and the difference is enormous

**Severity: low, and well documented.** With `resetBalanceEvery: 1` the pilot's product reports
95.11% success at 100,000 transactions. Without it, 1.02% — because a hundred thousand payments in
one simulated day exhaust a daily limit, correctly.

The simulator emits a caveat saying exactly this, in the report, and the pilot missed it on the
first read. That is a note about how reports get read rather than a framework defect: the caveat
was there and it was true.

**What should change:** nothing in the code. The evidence pack now reports both modes.

## CLI issues

**No way to pass a scenario mix.** `trustos financial-product simulate` takes `--count` and
`--seed`. The `scenarioMix`, `duplicateEvery` and `resetBalanceEvery` options exist on
`simulate()` and are not reachable from the CLI, so the pilot's simulation evidence is produced by
a test rather than by a command.

That is a real gap: the CLI's simulation always runs the all-success path, which the simulator's
own caveat describes as measuring the product's internal logic and not being a reliability estimate.

**Everything else worked.** `financial-product create`, `validate`, `list` and the phase-13
commands behaved as documented on first use.

## Documentation issues

- `WalletService.credit` — see (3) above.
- The limits documentation explains reservation, windows and timezones thoroughly, and does not
  mention that a limit's `organizationId` must match the caller's.
- `docs/maker-checker.md` does not mention `checkApproverEligibility` outside a workflow.

## Manual work required

Beyond the 1,849 lines of application code:

- **Opening the platform's own accounts.** The clearing account and the fee revenue account are
  opened in `pilot.ts`. This is correct — a framework that invented a chart of accounts would be
  wrong — and it is manual work every deployment does.
- **Choosing the fee schedule's floor and ceiling.** Configuration, and a real agreement supplies
  the numbers.
- **Deciding the idempotency key.** The framework provides the mechanism and takes no position on
  the key. The pilot chose the merchant's own reference, and that decision is 12 lines and one
  paragraph of comment.

## Where an AI coding agent struggled

Written because the specification asks, and because these are patterns rather than incidents.

**Guessing API shapes rather than reading them.** `WalletBalance` has `walletId`, not `wallet`.
`ExecutionRecord.outcome` is `'refusal'`, not `'refused'`. `SandboxRunResult` has
`unfiredScenarios`, not `unfired`. Each was a plausible guess and each was wrong, and each cost a
test run to discover. Reading the type first is faster every time.

**Asserting a hard-coded count.** Two gateway boot tests asserted "ten console templates". Adding
an eleventh broke them, and the correct fix was to count against `CONSOLE_TEMPLATES.length` —
because the point of those tests was never the number.

**Writing a test that asserts the wrong rule.** One pilot test asserted that a write scope cannot
read. It can, deliberately: a credential that may change something can necessarily observe it. The
framework was right and the test was wrong, and the failure looked at first like a framework bug.

**Documenting a role as read-only that holds a write permission.** `finance` approves limit
changes, which is a write. The pilot's own consistency check caught it — which is the argument for
writing that check.

## What TrustOS should improve next, in order

1. **Make "no limit applied" visible in a `LimitDecision`.** The highest-value change here: it is
   the one failure mode that produces no signal at all.
2. **Expose the simulator's scenario options through the CLI.** Without them, the CLI's simulation
   cannot produce evidence anybody should quote.
3. **One sentence in `WalletService.credit`'s documentation** saying that it posts.
4. **A paragraph in `docs/maker-checker.md`** showing `checkApproverEligibility` outside a workflow.
5. **A note in the limits documentation** about `organizationId` matching.

None of these is a design change. That is the most useful finding in this report: after building a
complete payment product on it, the framework's _shape_ was not the problem in any of the five
cases — its discoverability was.
