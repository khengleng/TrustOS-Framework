# Model router

Applications say what they need. The router says which model. **Never hardcode a model name inside
an application.**

- [Why](#why)
- [The registry](#the-registry)
- [Asking for a model](#asking-for-a-model)
- [Profiles](#profiles)
- [Fallback](#fallback)
- [Determinism](#determinism)
- [When routing finds nothing](#when-routing-finds-nothing)
- [Retiring a model](#retiring-a-model)

---

## Why

A model name in application code is a deployment decision embedded in a service file. When the
model is deprecated — and it will be, on the provider's schedule — the fix is a search across every
repository, a review, and a deploy per application.

With a registry it is one row: mark it retired, name its successor, and every application follows
on the next request.

There is a second reason, less obvious and more expensive: a hardcoded model cannot fall back. When
the provider has an incident, an application naming `gpt-4o` fails. An application asking for
"fast, supports tools, at least 32k of context" gets served by whatever can do that.

## The registry

```ts
const models = new ModelRegistry({
  models: [
    {
      id: 'openai.gpt-4o',
      provider: 'openai',
      providerModelId: 'gpt-4o',
      displayName: 'GPT-4o',
      contextTokens: 128_000,
      maxOutputTokens: 16_384,
      capabilities: ['tools', 'json_mode', 'vision'],
      pricing: {
        inputCentsPerMillion: 250,
        outputCentsPerMillion: 1000,
        cachedInputCentsPerMillion: 125,
        verifiedAt: new Date('2026-07-01'),
      },
      p50LatencyMs: 900,
    },
  ],
});
```

Four fields are more load-bearing than they look:

- **Pricing is in cents per million tokens, as integers.** Floating-point money multiplied by a
  million-token count accumulates error that surfaces as a cost report nobody can reconcile.
- **`verifiedAt` is when somebody last checked the price.** `registry.validate()` warns past 180
  days, because a cost report computed from year-old pricing is confidently wrong, which is worse
  than missing.
- **`p50LatencyMs` is nullable and null means _unknown_, not _fast_.** A router that treats an
  absent latency as zero routes everything to the model nobody has measured.
- **`allowedOrganizationIds`** — empty means every tenant; otherwise an allow-list. For a model
  under evaluation, or one a single customer's contract permits.

The framework ships **no models**. Prices change monthly and availability varies by account, so a
shipped catalog would be wrong for everybody within weeks. `trustos ai list-models` says so when it
finds none.

## Asking for a model

```ts
// The normal case: say what you need.
model: {
  kind: 'requirement',
  profile: 'balanced',
  capabilities: ['tools'],
  minContextTokens: 32_000,
  maxInputCostPerMillion: 500,
}

// The exception: name one.
model: { kind: 'model', modelId: 'openai.gpt-4o' }
```

An explicit model gets **no fallback**. A caller who named a model asked for that model, and
quietly serving a different one turns a failure into a wrong answer that looks fine. If you want
resilience, ask for a requirement.

## Profiles

| Profile    | Sorts by                        | For                             |
| ---------- | ------------------------------- | ------------------------------- |
| `fast`     | latency, then cost              | anything a person is waiting on |
| `balanced` | cost, then latency              | the default                     |
| `deep`     | context window, then capability | analysis, long documents, code  |

A profile is a name for a trade-off, so the trade-off is made once and reviewed, rather than
re-argued in every service that calls a model.

## Fallback

```
  first choice unavailable ─▶ next candidate ─▶ next ─▶ AiError.noModelAvailable
```

The gateway distinguishes three provider failures, and treats them differently:

| Failure                         | Response                                                             |
| ------------------------------- | -------------------------------------------------------------------- |
| `retryable` (timeout, 429, 5xx) | retry the same model, with backoff and jitter                        |
| `modelUnavailable`              | mark it unavailable in the registry, fall back to the next candidate |
| `refused`                       | **stop**                                                             |

The third is a decision, not an outage. A provider's safety filter refusing a request is an answer,
and routing around it to get a different answer is a way of not taking it. The error says the
provider refused, and does not pretend the platform could not find a model.

`markUnavailable(id, reason, forMs)` defaults to fifteen minutes. Time-limited on purpose: a
permanent mark needs somebody to clear it, and nobody does, so a transient outage becomes a model
that is quietly never used again.

## Determinism

Candidates are sorted by the profile's criteria and tie-broken on model id. Given the same registry
and the same request, every pod picks the same model.

Without the tie-break, two models with identical cost and latency would be chosen by whatever order
the map iterated, and the same request would hit different models on different pods — which makes
"why did this answer change" unanswerable.

## When routing finds nothing

`explainEmpty` names the filter that emptied the list:

> No model matched: 6 registered, 4 permitted by policy, 2 with the `tools` capability, 0 with at
> least 200,000 tokens of context.

A bare "no model available" sends somebody to check the provider's status page when the actual
problem is a `minContextTokens` that no registered model satisfies.

## Retiring a model

```ts
registry.register({
  id: 'openai.gpt-4-turbo',
  status: 'retired',
  statusReason: 'Deprecated by the provider on 2026-06-01.',
  supersededBy: 'openai.gpt-4o',
  // …
});
```

A retired model is never routed to. A request naming it explicitly gets an error that says what to
use instead, and `registry.validate()` fails at boot if `supersededBy` names a model nobody
registered — a caller told to move somewhere that does not exist is worse off than one told
nothing.

## Related

- [ai-architecture.md](ai-architecture.md) — where routing sits in the pipeline
- [cost-monitoring.md](cost-monitoring.md) — the pricing these numbers feed
- [ai-security.md](ai-security.md) — unsafe model selection and model spoofing
