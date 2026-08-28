# Evaluation

Measuring whether a change made things worse. Read the first section before you use any of the
numbers.

- [What these numbers are](#what-these-numbers-are)
- [Suites and cases](#suites-and-cases)
- [Running one](#running-one)
- [The metrics](#the-metrics)
- [Comparison is the product](#comparison-is-the-product)
- [In CI](#in-ci)
- [Model-graded and human metrics](#model-graded-and-human-metrics)
- [Building a suite that is worth having](#building-a-suite-that-is-worth-having)

---

## What these numbers are

Most metrics here are **heuristics computed from text**.

`groundedness` measures how much of an answer's vocabulary appears in the sources it was given. It
detects an answer that wandered away from its context. It does **not** detect one that is fluently
wrong about something the sources also got wrong, and an answer that copies a sentence verbatim
scores 1.0 whether or not the sentence is true.

`relevance` compares the answer to the question the same way, with the same limits.

Neither measures truth. A package that reported them as "accuracy" would be lying in a way that is
very hard to notice, because the number looks fine.

They are useful for exactly one thing, and it is worth a great deal: **detecting change**. A
groundedness of 0.62 means little. A groundedness that was 0.81 last week and is 0.62 today means
somebody changed a prompt, and that is a question worth asking.

The metrics that _are_ exact say so in their `kind`:

| Metric                                   | Kind         | Exact?                                     |
| ---------------------------------------- | ------------ | ------------------------------------------ |
| `citation_coverage`                      | measurement  | Yes — a `[4]` with three sources is a fact |
| `schema_compliance`                      | measurement  | Yes — it parses or it does not             |
| `expected_content` / `forbidden_content` | measurement  | Yes — the string is there or not           |
| `latency` / `cost`                       | measurement  | Yes                                        |
| `safety`                                 | measurement  | Yes — it reports the guardrail's decision  |
| `groundedness` / `relevance`             | heuristic    | **No**                                     |
| `model_graded`                           | model_graded | As good as the grader                      |

## Suites and cases

```json
{
  "id": "support-answers",
  "name": "Support answers",
  "subject": "support-agent",
  "latencyBudgetMs": 5000,
  "costBudgetCents": 2,
  "defaultThresholds": { "citation_coverage": 0.5 },
  "cases": [
    {
      "id": "refund-window",
      "input": "How long do I have to request a refund?",
      "sources": ["Refunds may be requested within 30 days of delivery."],
      "expected": ["30 days"],
      "forbidden": ["guarantee", "immediately"],
      "thresholds": { "groundedness": 0.6 },
      "tags": ["refunds", "common"],
      "note": "The commonest question, and the one where a wrong number costs money."
    }
  ]
}
```

Two fields carry more weight than they look:

- **`note` is required.** A case with no stated purpose gets deleted the first time it fails,
  because nobody remembers whether it was testing something real.
- **`forbidden` is the more important half of the pair.** A suite that only checks for the right
  things does not notice the wrong ones arriving. "Never promise a refund", "never state an account
  number", "never say 'as an AI'" — those are the failures that cost money.

Thresholds are per case, with a suite-level default. One global pass mark forces every case to the
strictness of the hardest one, which in practice means the mark gets lowered until everything
passes and the suite stops meaning anything.

## Running one

The evaluation runs inside the application, because it needs a gateway, credentials, a tenant and a
policy:

```ts
const { run, comparison } = await evaluation.runAndCompare({
  suite,
  variant: `prompt-v${promptVersion}`,
  organizationId: null,
  target: async ({ case: entry }) => {
    const hits = await retriever.retrieve({ query: entry.input /* … */ });
    const answer = await gateway.complete(/* … */);

    return {
      output: answer.content ?? '',
      costCents: answer.costCents,
      latencyMs: answer.latencyMs,
      safety: guardrails.checkOutput({ content: answer.content /* … */ }),
    };
  },
});
```

`variant` is what makes the history usable: two runs of a suite are only comparable when you know
what changed between them.

A case that throws is recorded as **errored**, not failed. Different things — a failed case was
measured and scored badly; an errored one was never measured, so averaging it in would invent a
number. A suite keeps going after one case breaks, because a report about one problem is not the
report you asked for.

## The metrics

Each `MetricResult` carries a `detail` string explaining the number in words, which is what appears
beside it in a report. Groundedness always ends with _"This measures overlap with the sources, not
correctness."_ — inside the data, not only in this document, because the number gets copied into
dashboards and the caveat has to travel with it.

`latency` and `cost` are normalised: at or under budget scores 1, twice the budget scores 0. A
suite averaging "3200" with "0.81" produces a number that means nothing.

## Comparison is the product

```ts
const comparison = evaluation.compare(baseline, candidate, { tolerance: 0.05 });
```

Reported **per case**, never as a moved average:

```ts
{
  verdict: 'worse',
  newFailures: ['refund-window'],
  regressions: [
    { caseId: 'refund-window', metric: 'groundedness', from: 0.81, to: 0.42, detail: '…' },
  ],
  improvements: [/* … */],
  fixed: [],
  scoreDelta: { groundedness: -0.13, relevance: 0.02 },
}
```

An average that moved from 0.78 to 0.76 hides two cases falling off a cliff behind three improving
slightly, and the two are the ones somebody needs to look at.

The tolerance exists because a non-deterministic model moves every score a little on every run.
Reporting that as a regression trains everybody to ignore the report, which costs more than the
noise did.

## In CI

```bash
trustos ai evaluate                                            # validate suites
trustos ai evaluate --baseline main.json --candidate pr.json   # exit 1 on a regression
```

The CLI does not call a model, and the reason is worth stating rather than hiding: doing so needs
provider credentials, a gateway, a tenant and a policy — everything the application has and the CLI
deliberately does not. The application runs the evaluation and writes the result; the CLI compares
results and fails the build.

`trustos ai evaluate` also warns about two suites that look fine and are not:

- **No case sets a threshold.** It produces scores that can never fail, and a report full of
  passing numbers reads exactly like a suite that passed.
- **No case states what the answer must or must not contain.** Only the generic heuristics apply,
  and those measure change rather than correctness.

## Model-graded and human metrics

The framework ships **no grader**. A grader is a model call and a prompt, and both belong to the
deployment.

```ts
const evaluation = new EvaluationService({
  store,
  modelGrader: async ({ case: entry, output }) => {
    const verdict = await gateway.complete(/* a grading prompt */, context);
    return { score: parse(verdict), detail: verdict.content ?? '' };
  },
});
```

Two cautions worth having in front of you:

1. A model grading a model shares its blind spots. Where possible, grade with a different model
   family than the one being graded.
2. A grader is itself a prompt that can regress. Version it in the
   [prompt registry](prompt-registry.md) like any other.

Human scores come through [human-review](human-review.md): approve, reject, or approve with a
correction. The correction is the most valuable evaluation data in the system, because it is a
person saying exactly what the right answer was.

## Building a suite that is worth having

Start with fifteen cases, not two hundred:

| Include                                          | Why                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| The five commonest real questions                | If these regress, everybody notices anyway — but you notice first |
| Three where the right answer is _"I don't know"_ | The failure that costs the most, and the one nobody tests         |
| Three adversarial inputs                         | Injection attempts, and requests to do something the actor cannot |
| Two where the sources disagree                   | The model should say so, not pick one                             |
| Two edge cases from a real incident              | The ones that already cost something                              |

Grow it from production. Every output a reviewer rejects is a case, and its `note` writes itself:
_"Rejected 2026-07-14 — promised a refund the sources do not support."_

## Related

- [rag.md](rag.md) — citations and what groundedness cannot see
- [human-review.md](human-review.md) — where human scores come from
- [prompt-registry.md](prompt-registry.md) — what a `variant` usually is
- [ai-architecture.md](ai-architecture.md) — where evaluation sits, and the `ai.evaluation.regressed` event
