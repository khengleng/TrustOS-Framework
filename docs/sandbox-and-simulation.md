# Sandbox and simulation

Two ways to run a product without a customer: one transaction against mock providers with a
chosen failure injected, and a hundred thousand of them with a report.

- [The isolation guarantee](#the-isolation-guarantee)
- [A sandbox run](#a-sandbox-run)
- [The failure scenarios](#the-failure-scenarios)
- [What the mocks do](#what-the-mocks-do)
- [Simulation](#simulation)
- [Reading the report](#reading-the-report)
- [What the numbers do not mean](#what-the-numbers-do-not-mean)

---

## The isolation guarantee

**The sandbox has no path to production data**, and that is structural rather than a rule somebody
follows.

It constructs its own connector registry, its own idempotency store, its own event publisher and
its own audit recorder, all in memory, inside the function. There is no constructor parameter
through which a production one could arrive. "The sandbox must never use production credentials"
is not a policy this package enforces; it is a sentence that has nowhere to be violated.

`assertSandboxSafe` is the belt to that braces: it refuses a configuration object carrying anything
named like a secret, token, password, credential or key. The sandbox has no use for one — every
provider is a mock — so anything that looks like one is a production value that reached a test
path.

A run is also **deterministic**. The clock is fixed at a stated epoch, references come from a
counter rather than a UUID, and the mock handlers hold no randomness. Two runs of the same product
with the same inputs produce byte-identical records, which is what makes "did my change do
anything" a comparison rather than an impression.

## A sandbox run

```ts
const result = await runSandbox({
  version, // a published version
  input: { amountMinorUnits: '150000', currency: 'USD', transactionType: 'CREDIT' },
  scenarios: [{ scenario: 'settlement_failure', atBlock: 'settle', times: 1 }],
});

result.execution.state; // 'failed'
result.execution.steps; // every block, with its outcome and duration
result.execution.ruleDecision; // the rules, with the full trace
result.events; // what would have been published
result.audit; // what would have been recorded
result.unfiredScenarios; // armed and never triggered — a gap, not a pass
```

A sandbox run may exercise a version that is **not active** — that is the point of it. The binding
still refuses a retired one, and it still verifies the content hash: a definition edited outside
the approval path must not be runnable anywhere, including here.

`unfiredScenarios` is worth watching. A scenario that was armed and never fired usually means it
was pointed at a block key that does not exist, and a run that reports "no failures" because the
failure never happened is the least useful possible result.

## The failure scenarios

Twelve. The eight section 15 of the specification asks for, plus four the runtime's own shape makes
worth exercising.

| Scenario                  | Outcome            | Retryable |
| ------------------------- | ------------------ | --------- |
| `success`                 | success            | —         |
| `provider_timeout`        | failed             | yes       |
| `provider_failure`        | failed             | no        |
| `insufficient_balance`    | refused            | no        |
| `limit_exceeded`          | refused            | no        |
| `risk_rejection`          | refused            | no        |
| `kyc_rejection`           | refused            | no        |
| `settlement_failure`      | failed             | no        |
| `reconciliation_mismatch` | refused            | no        |
| `duplicate_request`       | success (replayed) | —         |
| `compensation_failure`    | failed             | no        |
| `review_required`         | held               | —         |

The **refused/failed** column is the reason a catalog exists rather than ad-hoc mocking. A product
owner who has to write a provider timeout will write a provider timeout, and will not write a
settlement failure or a reconciliation mismatch, because those are not the failures they are
thinking about. A closed list turns "did you test the failure paths" from a conversation into a
checklist with a result.

`compensation_failure` is the one most products have never run. It produces
`state: 'compensation_failed'` — a half-unwound transaction that a person must finish — and it is
worth running once before a product goes live rather than at 3am.

An injection fires a configured number of times and then stops, so `times: 1` against a block with
a retry policy exercises **the retry succeeding on the second attempt**, which is the behaviour
most products assume and few have run.

## What the mocks do

One handler per approved block, **generated from the catalog** rather than written out — which is
what keeps the sandbox complete as the catalog grows. A sandbox missing a handler for the block
somebody just added is a sandbox that reports a product as broken when it is the sandbox that is.

**The providers are mocked; the money is not.** Balances, limits and fees are computed with
`@trustsystem/financial-core`'s `Money`, not with numbers, because the sandbox's job is to tell a
product owner what their configuration produces — and a sandbox that used floats would tell them
something that disagrees with production once in ten thousand transactions.

Concretely, the mocks:

- track a synthetic balance and check the **available** balance on a debit, never the total;
- accumulate limit consumption against the ceilings the product declares, and refuse when a
  transaction would breach one;
- compute a fee exactly, at a placeholder rate, and show its workings;
- mint deterministic references so two runs agree.

They deliberately do **not** read the product's fee schedule. Pricing a fee from a schedule is
`@trustsystem/fees`' job, and a second implementation here would be a second set of rounding
decisions. What the sandbox demonstrates is that the plumbing carries a fee through to the ledger —
which is the thing a composition can get wrong.

The sandbox also registers a **mock connector for every provider interface**. Without them a
sandbox would refuse every template at the first provider-dependent block with "nothing binds one"
— which is true, and is exactly the state a sandbox exists to let a product owner work in.

## Simulation

```ts
const report = await simulate({
  version,
  count: 100_000,
  seed: 2026, // required
  amountRange: { minMinorUnits: '100', maxMinorUnits: '600000' },
  scenarioMix: { provider_timeout: 0.01, risk_rejection: 0.02 },
  duplicateEvery: 50,
  resetBalanceEvery: 1,
});
```

`seed` is **required** rather than optional. An optional seed gets omitted, and then two reports
cannot be compared — which is the only thing anybody wants to do with a second report.

The generator is `mulberry32`: thirty-two bits of state, four operations per draw, the same
sequence on every platform. Deliberately not `Math.random()`, because the first thing anybody does
with a simulator is run it twice.

One runtime, one handler registry and one connector registry are built **outside the loop**. A
hundred thousand executions each constructing a registry over eighty-four blocks is a hundred
thousand registries, and the simulator would spend its time on that rather than on the product.
100,000 transactions run in roughly six seconds on a laptop.

## Reading the report

```text
merchant-wallet-basic@1.0.0 — 100000 executed of 100000 requested (seed 2026)

  success   96812 (96.81%)
  refused    2093
  failed     1095 (1.10%)
  open          0

  reviews required      0
  limit refusals        0
  duplicates prevented  0
  compensations run  1095
  SLA breaches          0
  journals posted   96812
  settlements created 96812

  path distribution:
     96.81%  verify-merchant -> create-wallet -> configure-limits -> accept-payment -> …
      2.09%  verify-merchant -> create-wallet -> configure-limits
      1.10%  verify-merchant -> create-wallet -> configure-limits -> accept-payment -> … -> adjust-settlement
```

**The path distribution is the measure worth running a simulation for.** A product owner can read
a fee off a definition; what they cannot read is that 4% of transactions take the enhanced-review
branch, which is forty people a day at the volume they are planning. Every other number in the
report is checkable by hand on ten transactions; this one is not checkable at all without running
it.

A **replayed duplicate is counted once**. Counting it twice would report a hundred thousand
transactions when ninety thousand ran, and the success rate would be computed over the wrong
denominator.

## What the numbers do not mean

The report states its own caveats, because somebody will paste them into a capacity plan.

**The latencies are the runtime's own overhead.** Every handler is a mock that returns
immediately. Quoting them as end-to-end latency would be quoting a number that has never met a
network.

**A success rate is a rate under the injected mix.** With no scenarios injected it measures the
product's internal logic and nothing else — which is useful, and is not a reliability estimate.

**Fees come from the sandbox's placeholder rate**, not the product's schedule.

**With `resetBalanceEvery: 1`, cumulative limits refuse nothing.** Limit consumption is cleared
between transactions so each one is measured on its own, which means a zero in "limit refusals"
says nothing about how a daily limit behaves over a real day. The report says so in its caveats
whenever that option was used — a zero that looks like a pass and is an artefact of the harness is
the worst number a report can contain.

**This is not a load test.** For throughput, latency under concurrency, or capacity, run the real
runtime against real handlers with a load tool. The simulator answers "what does this product
do", not "how fast is this deployment".
