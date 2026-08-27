# Policy governance

## The lifecycle

```text
draft → under_review → approved → active → deprecated → retired
```

Only `active` decides. `PolicyEngine.decide` refuses anything else, including a pinned version,
because a draft that could decide would take effect the moment somebody wrote it.

## The author does not activate

Two controls, and they are different:

The **permission split** — `POLICY_AUTHOR` and `POLICY_ACTIVATE` are a `SEGREGATED_PAIRS` entry, so
no role holds both.

The **actor check** — `PolicyController.activate` refuses when `policy.owner === actor.userId`.

The second exists because the first is not enough. Somebody may legitimately hold both roles over
different policy sets: authoring data policies and activating API policies is a reasonable job. The
actor check is what stops that person activating the one they wrote.

A policy is a rule that governs everybody else. One person writing and enacting it is unreviewed
rule-making, and the fact that it produces no journal entry does not make it smaller than a
financial approval.

## Activation requires passing tests and clean analysis

```ts
const validation = engine.validate(policy);
if (!validation.valid) throw ApiError.conflict(/* ... */);
```

Checked at activation rather than only at authoring time, because a policy can be written, reviewed
over a week, and activated against a framework that has since changed.

## The decision log

Every decision carries the **policy version**. That is what makes it re-derivable: an auditor takes
the version, the attributes and the evaluator, and gets the same answer.

Sensitive attributes are hashed rather than stored:

```ts
hashAttribute(value, salt);
```

A decision log containing the attribute values it decided on is a second copy of the data, in a
system with different access controls and a longer retention. Hashing keeps the record checkable —
`reDerivable` confirms a claimed decision matches — without keeping the values.

`PolicyDecisionLog.record` does **not** swallow failures. If the sink rejects, the decision fails.
An engine that decided successfully while failing to record would be an engine whose log has holes
exactly where something went wrong.

## Reviews

`reviewDate` is required and must be after `effectiveDate`. `PolicyRegistry.overdueReviews(asOf)`
returns everything past it.

Overdue is reported, not enforced. A policy that stopped working because nobody reviewed it would
be an outage caused by governance, and after the first one the review interval gets set to ten
years.
