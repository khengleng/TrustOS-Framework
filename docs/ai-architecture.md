# AI architecture

Phase 7 is the layer that lets every application on this platform use AI safely. Twenty-six
packages, one rule that shapes all of them:

> **Applications never call a provider.** They ask the gateway, and the gateway is where policy,
> guardrails, routing, cost and audit live.

- [The shape](#the-shape)
- [How the pieces fit](#how-the-pieces-fit)
- [The request pipeline](#the-request-pipeline)
- [The five registries](#the-five-registries)
- [What is deliberately absent](#what-is-deliberately-absent)
- [Provider neutrality, concretely](#provider-neutrality-concretely)
- [Choosing where to start](#choosing-where-to-start)
- [Running it](#running-it)

---

## The shape

Same rule as the integration layer, applied to a harder problem: the framework ships the seam and
a default that needs nothing installed, and it does not ship the provider.

There is an `AiProviderAdapter` interface and an echo adapter for tests, and no OpenAI client.
There is a `VectorStore` interface and an in-memory implementation, and no pgvector adapter. There
is an `EmbeddingProvider` port and a deterministic hashing provider, and no embedding model.

For AI this matters more than it did for events, for a reason worth stating plainly: **the
provider landscape changes every few months**. A framework that hardcoded a provider in 2024 would
have been rewritten twice by now, and every application built on it would have been rewritten with
it. The seam is what lets a deployment change its mind.

## How the pieces fit

```
   application
        │
        │  complete(request, context)      ← never a provider SDK
        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  ai-gateway                                                 │
   │    ai-policy      what this tenant may do                   │
   │    prompt-registry  which prompt version, immutable         │
   │    guardrails     prompt-security + content-filter          │
   │    model-router   which model, and the fallback             │
   │    ai-cache       tenant-scoped, opt-in                     │
   │    token-meter    does it fit                               │
   │    cost-monitor   what it cost, and the budget              │
   │    audit          that it happened                          │
   └──────────────────────────┬──────────────────────────────────┘
                              │  AiProviderAdapter
                              ▼
                    OpenAI · Anthropic · Gemini · OpenRouter
                    xAI · Ollama · vLLM · whatever comes next
                              (none shipped)

   ┌── retrieval ──────────────┐   ┌── agents ──────────────────────┐
   │  knowledge  collections   │   │  agent-framework  definitions  │
   │  rag        chunk, fuse   │   │  agent-runtime    the loop     │
   │  embedding  vectors       │   │  tool-execution   permissions  │
   │  vector-store  interface  │   │  agent-memory     five scopes  │
   └───────────┬───────────────┘   │  conversation     context fit  │
               │                   └───────────┬────────────────────┘
               └────── both call the gateway ──┘
                              │
   ┌──────────────────────────┴──────────────────────────────────┐
   │  human-review    output a person must approve               │
   │  evaluation      whether it got worse                       │
   │  ai-observability  what happened, in numbers                │
   │  ai-workflows    the seam into phase 5 and phase 6          │
   └─────────────────────────────────────────────────────────────┘
```

Three couplings surprise people, so they are named here:

1. **An agent is a loop around the gateway**, not a parallel path. Every step an agent takes is an
   ordinary gateway request with the same policy, guardrails, cost and audit. There is no "agent
   mode" that skips them.
2. **Retrieval does not call a model to retrieve.** It calls an embedding provider, searches, and
   hands passages to the caller. The model call that turns passages into an answer is a separate,
   ordinary gateway request — which is why a bad retrieval and a bad answer are separable.
3. **Human review suspends rather than blocks.** A workflow step waiting on a person returns a
   token and ends. See [human-review.md](human-review.md).

## The request pipeline

`AiGateway.complete` runs twelve steps in a fixed order. The order is the design; several steps
are only correct where they are.

| #   | Step                                       | Why here                                                        |
| --- | ------------------------------------------ | --------------------------------------------------------------- |
| 1   | Resolve tenant policy                      | Everything downstream depends on what this tenant may do.       |
| 2   | Resolve the prompt version                 | So the audit record names a version, not a string.              |
| 3   | Scan untrusted variables                   | Before the text is assembled into a prompt.                     |
| 4   | Input guardrails                           | Before anything is sent or cached.                              |
| 5   | Route to a model                           | After policy, so a denied model is never chosen.                |
| 6   | Check the context window                   | Before paying for a request that cannot fit.                    |
| 7   | Check the budget                           | Estimated cost against the tenant's ceiling.                    |
| 8   | Cache lookup                               | Keyed on a context that includes the tenant structurally.       |
| 9   | Call the provider, with retry and fallback | The only step that leaves the process.                          |
| 10  | Output guardrails                          | The model's output is untrusted input to whatever renders it.   |
| 11  | Record cost and telemetry                  | Measured usage where the provider gave it, estimated otherwise. |
| 12  | Audit                                      | Metadata always; content never.                                 |

Two orderings are load-bearing and easy to get wrong:

- **Guardrails before the cache, not after.** A blocked prompt must never be able to produce a
  cache entry, and a cached response must still pass output guardrails when profiles change.
- **Policy before routing.** Routing first and checking after means a tenant's denied model has
  already been chosen, and the error says "not permitted" about a model the caller never asked
  for.

## The five registries

Everything an application configures lives in a registry rather than in code:

| Registry            | Answers                                              | Never                                         |
| ------------------- | ---------------------------------------------------- | --------------------------------------------- |
| **model-registry**  | Which models exist, what they cost, what they can do | Never hardcode a model name in an application |
| **prompt-registry** | Which prompt text is live, and who approved it       | Never edit a published version                |
| **ai-policy**       | What this tenant may do                              | Never merge two policies                      |
| **knowledge**       | Which collections exist and who may read them        | Never default a collection to readable        |
| **agent-framework** | Which agents exist and what each may do              | Never let an agent grant itself a tool        |

The reason is the same in each case: these are the decisions that change without a deploy, that
somebody needs to review, and that an auditor will ask about a year later. A model name in a
`const` answers none of those questions.

## What is deliberately absent

| Not here                                       | Where it belongs                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Provider adapters                              | The application. See [Provider neutrality](#provider-neutrality-concretely). |
| Provider credentials                           | The environment. Never a file in the repository.                             |
| A production embedding model                   | The application, behind `EmbeddingProvider`.                                 |
| A vector database                              | The application, behind `VectorStore`.                                       |
| A chat user interface                          | The product.                                                                 |
| Business agents — lending, payments, merchants | The product. Nine engineering examples ship as examples.                     |
| Fine-tuning, training, GPU infrastructure      | Outside the framework entirely.                                              |
| Image, audio and video generation              | Not in this phase.                                                           |

The list is not a roadmap. A framework that shipped a merchant onboarding agent would be making a
product decision for every deployment, and the deployments that disagreed would carry it anyway.

## Provider neutrality, concretely

An adapter is about eighty lines. This is the whole interface:

```ts
export interface AiProviderAdapter {
  readonly provider: string;
  complete(request: AdapterRequest, signal?: AbortSignal): Promise<AdapterResponse>;
  stream?(request: AdapterRequest, signal?: AbortSignal): AsyncIterable<CompletionChunk>;
  health?(): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; detail: string }>;
}
```

Four rules an adapter must follow, each of which the gateway depends on:

1. **Throw `ProviderError`**, with `retryable`, `modelUnavailable` and `refused` set correctly.
   The gateway retries a `retryable` failure, falls back on `modelUnavailable`, and does **not**
   route around `refused` — a provider's safety refusal is a decision, and trying another provider
   to get a different answer is a way of not taking it.
2. **Report usage** from the provider where it gives it, and mark it `estimated` where it does not.
   A cost report that cannot separate the two is one nobody can reconcile against an invoice.
3. **Never log the request or the credential.** `redactAdapterConfig` prints `[SET]` or
   `[NOT SET]`, never a prefix.
4. **Pass `providerOptions` through untouched**, and ignore keys you do not recognise — a request
   written for one provider must still run on another.

Register it and the rest of the platform works:

```ts
const gateway = new AiGateway({
  adapters: [new OpenAiAdapter({ apiKey: process.env.OPENAI_API_KEY! })],
  models,
  policy,
  guardrails,
  cost,
  audit,
});
```

## Choosing where to start

| You want to                | Install                      | Read                                                     |
| -------------------------- | ---------------------------- | -------------------------------------------------------- |
| Call a model at all        | `trustos add-module ai`      | this document, then [guardrails.md](guardrails.md)       |
| Answer from your documents | `+ trustos add-module rag`   | [rag.md](rag.md)                                         |
| Let a model take actions   | `+ trustos add-module agent` | [agents.md](agents.md), [ai-security.md](ai-security.md) |
| Control spend              | already in `ai`              | [cost-monitoring.md](cost-monitoring.md)                 |
| Know whether it got worse  | already in `ai`              | [evaluation.md](evaluation.md)                           |

`rag` and `agent` both depend on `ai`, because neither can work without a gateway.

## Running it

```bash
trustos add-module ai
trustos ai doctor            # wiring, schema, catalog, secrets — all offline
trustos ai list-models
trustos ai validate-prompts
```

`trustos ai doctor` is deliberately offline: no database, no network, no credentials. That is what
makes it usable on a laptop against a checkout, which is when the question is asked. It says what
it cannot see when run with `--verbose`.

The AI tables are part of the framework schema, so installing a module needs no migration. An
application generated before phase 7 needs its `prisma/schema/00-framework.prisma` refreshed —
`trustos ai doctor` says so, naming the missing tables.

## Related

- [agents.md](agents.md) — using agents
- [agent-framework.md](agent-framework.md) — writing tools and extending the runtime
- [prompt-registry.md](prompt-registry.md) — versioned prompts
- [rag.md](rag.md) — retrieval
- [guardrails.md](guardrails.md) — the safety pipeline
- [model-router.md](model-router.md) — model selection and fallback
- [evaluation.md](evaluation.md) — measuring change
- [human-review.md](human-review.md) — output a person must approve
- [cost-monitoring.md](cost-monitoring.md) — spend
- [ai-security.md](ai-security.md) — the threat model
