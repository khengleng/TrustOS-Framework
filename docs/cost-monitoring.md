# Cost monitoring

What AI costs, per tenant, per application, per agent, per model — and the budgets that stop a bug
from becoming an invoice.

- [Where the numbers come from](#where-the-numbers-come-from)
- [Recording](#recording)
- [Budgets](#budgets)
- [Reporting](#reporting)
- [Caching](#caching)
- [The cost drivers](#the-cost-drivers)
- [Estimated versus measured](#estimated-versus-measured)
- [Operating](#operating)

---

## Where the numbers come from

`usage × pricing`, both from sources that can be wrong in different ways:

- **Usage** comes from the provider when it reports it, and from `token-meter` when it does not —
  streaming responses often omit usage, and a cache hit has no provider call at all.
- **Pricing** comes from the [model registry](model-router.md), in cents per million tokens, as
  integers.

Two rules that stop the arithmetic being subtly wrong:

1. **Cached prompt tokens are billed once**, at the cached rate, not at both rates. Double-counting
   them makes cache hits look more expensive than misses.
2. **Reasoning tokens are counted separately.** Reasoning models bill for tokens that never appear
   in the output, and folding them into completion tokens makes the cost look inexplicable relative
   to the text you can see.

## Recording

The gateway records automatically. `CostMonitor.record` **never throws**:

```ts
await cost.record({/* … */}); // failure here is a gap in a report, not a failed request
```

A cost store outage that failed customer requests would be an outage caused by the accounting. The
same rule governs [ai-observability](ai-architecture.md#how-the-pieces-fit).

An unknown model costs **zero**, not an error and not a guess. A model missing from the registry is
a configuration problem, and inventing a price for it produces a report that reconciles to nothing.
`registry.validate()` catches the missing model at boot, which is where it belongs.

## Budgets

Three windows, checked in the pipeline before the provider is called:

```ts
const check = await cost.checkBudget({ organizationId, estimatedCostCents });

if (!check.allowed) throw AiError.budgetExceeded(check.alerts[0]!.message);
for (const alert of check.alerts) await events.publish(budgetWarning(alert));
```

| Window    | Stops               | Typical use            |
| --------- | ------------------- | ---------------------- |
| `request` | one runaway request | a cap on a single call |
| `day`     | a bug that loops    | the real safety net    |
| `month`   | contract overrun    | commercial             |

The per-day limit is the one that saves you. The failure it catches is not a busy day; it is an
agent whose stop condition stopped working, retrying at machine speed at three in the morning.

`checkBudget` returns `{ allowed, alerts }` rather than throwing, so a caller can warn at 80% and
block at 100% without two calls and two code paths.

## Reporting

```ts
const report = await cost.report({ organizationId, from, to });
```

Grouped by model, application, agent and day. Two properties of the numbers:

- **Rounded once**, at the end. Rounding each row and summing produces a total that disagrees with
  the rows, and somebody will notice.
- **`estimatedFraction` is stated.** The share of the cost derived from estimated rather than
  provider-reported usage. A report that cannot separate them is one nobody can reconcile against
  an invoice, and reconciliation is the only thing that proves the numbers are right.

`ai-observability` reports the same spend alongside latency, failures and cache hit rate — from the
same `ai_request_log` table, so the two cannot disagree.

## Caching

The cache is **off by default**, per tenant policy (`allowCaching`).

That default is not caution for its own sake. A cache keyed on prompt text returns one tenant's
answer to another the moment the key is built carelessly, and "carelessly" is the default state of
a cache key.

So the key cannot be built without a tenant:

```ts
const key = buildCacheKey({
  organizationId, // structural, not a string parameter
  modelId,
  messages,
  temperature,
  responseFormat,
});
```

`buildCacheKey` takes a context, not a string. A key that omits the organization is not something a
caller can construct by forgetting an argument. Reads then check the organization again on the
returned entry — belt and braces, because the failure is silent and the cost of the extra check is
a comparison.

**Never cache a sensitive request unless it is explicitly allowed.** A `confidential` knowledge
collection is never cached; a request carrying personal data should not be.

Cache savings are reported as approximate, using the mean cost of an uncached request. The true
saving depends on which requests were cached, which is not knowable after the fact.

## The cost drivers

In the order they usually matter:

| Driver                  | Why                                                                            | What to do                                                  |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **Agent steps**         | Each step re-sends the whole conversation. Step 12 costs several times step 2. | Lower `maxSteps`; find the tool that keeps failing          |
| **Retrieved context**   | Ten passages instead of four is 2.5× the prompt on every call                  | Tune `topK` and `diversify`                                 |
| **Conversation length** | Unbounded history grows every turn                                             | Compact; set `maxTokens`                                    |
| **Model choice**        | Frontier models are 10–30× a small one                                         | Route by profile; use `fast` for anything a person waits on |
| **Retries**             | A retried request is a paid request                                            | Watch the retry rate                                        |
| **Tool results**        | A tool returning ten thousand rows puts them in the next prompt                | `maxResultChars` on the executor                            |

The first row is the one people miss. An agent that takes 8 steps instead of 3 does not cost 2.7×;
it costs closer to 6×, because the prompt grows every step.

## Estimated versus measured

| Situation                           | Usage from       | `estimated` |
| ----------------------------------- | ---------------- | ----------- |
| Normal completion                   | the provider     | `false`     |
| Streaming without a usage frame     | `token-meter`    | `true`      |
| Cache hit                           | the cached entry | `true`      |
| Provider error after partial output | `token-meter`    | `true`      |

`TokenMeter` is a heuristic — characters ÷ 3.6 for Latin text, with a multiplier for scripts above
U+0590, always rounding up. `estimateDrift` compares an estimate to a provider's actual count so a
deployment can measure its own error rather than trusting the constant.

Rounding up is deliberate. An estimate that runs low makes a request look affordable and then
overflows the context window, which fails after you have paid for the prompt.

## Operating

```bash
trustos ai list-models --verbose     # pricing, and how stale it is
```

Four things to watch:

| Signal                          | Meaning                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Cost per successful outcome     | The only number that matters commercially. Total spend without it is noise.  |
| `estimatedFraction` rising      | A provider stopped reporting usage, or streaming grew.                       |
| Pricing age past 180 days       | The registry warns. The report is confidently wrong until somebody checks.   |
| Spend concentrated in one agent | Usually a step limit that is too generous, or a tool that fails and retries. |

Set the daily budget before the first production request, not after the first surprise. It is five
minutes of configuration and it is the difference between a bad afternoon and a bad quarter.

## Related

- [model-router.md](model-router.md) — where pricing lives
- [agents.md](agents.md) — step limits, the largest driver
- [ai-architecture.md](ai-architecture.md) — where the budget check sits in the pipeline
