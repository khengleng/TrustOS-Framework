# Indicators, objectives and error budgets

## An indicator is a ratio, never an average

**Good events over valid events.** Everything in `@trustsystem/sli` follows from insisting on that
shape.

An average is the standard way a measurement stops being true. "Average latency 180ms" is
compatible with one request in twenty taking nine seconds, and the users experiencing those nine
seconds are exactly the ones who complain. A ratio of requests-under-threshold to requests-served
cannot hide them.

A latency indicator must state its `thresholdMs`. Without one it is an average wearing a different
name, and the schema refuses it.

## Counts, not percentages

`SliMeasurement` stores `goodEvents` and `validEvents` per bucket. Percentages cannot be
re-aggregated: averaging the hourly percentages of a day weights a quiet 4am hour the same as a
busy lunchtime, so a night-time blip outweighs a real one.

```ts
aggregate([
  { goodEvents: 1000, validEvents: 1000 }, // a busy hour
  { goodEvents: 0, validEvents: 1 }, // one failed request at 4am
]).percentage; // 99.9001, not 50
```

The schema also refuses `goodEvents > validEvents`. A counter reporting more successes than
requests is broken, and a broken counter that silently clamps produces a number somebody acts on.

## An unobserved window is `null`, not 100%

```ts
aggregate([{ goodEvents: 0, validEvents: 0 }]).ratio; // null
aggregate([{ goodEvents: 0, validEvents: 0 }]).unmeasuredReason; // 'no_valid_events'
```

If empty read 100%, an outage that stopped all traffic would _improve_ the number, and the
objective would be met precisely because the service was unreachable.

## Too little traffic to judge

```ts
sufficientToJudge(value, { objectivePercentage: 99.9 });
```

Fifty requests against a 99.9% objective: one failure moves it by 2%, twenty times the entire
allowance. Such a window can neither confirm nor deny compliance, so it reports
`insufficient_data` rather than a pass.

This is the specification's _do not claim compliance unless actual metrics support it_, as a
function rather than as reviewer discipline.

## The error budget

```ts
errorBudget(slo, value);
// { allowedBadEvents: 100, badEvents: 50, consumed: 0.5, state: 'healthy', actions: [...] }
```

Computed from event counts rather than from minutes, because that is what the indicator measures.
Minutes-of-downtime is a derived presentation, and deriving it assumes a uniform request rate no
real service has.

`consumed` is unclamped above 1. "140% of the budget" tells a team how far past the objective it
is, which is what decides whether this is a conversation or a postmortem.

## An exhausted budget recommends; it does not act

```ts
{
  consumedAtLeast: 1,
  state: 'exhausted',
  actions: ['stop_risky_rollout', 'require_incident_review', 'pause_nonessential_deployment'],
  rationale: 'The reliability the objective promised has already been missed. ...'
}
```

Every default action is reversible and leaves a human deciding. Nothing stops production traffic
and nothing rolls back automatically.

This is a deliberate position, not caution. A rule that halts production without a person in the
loop gets disabled the first time it is wrong, and after that it protects nothing.

The schema requires every objective to declare what an exhausted budget means. Deciding that during
the incident is how nothing gets decided.

## Burn rate

```ts
burnAlert({ fastBurn: 20, slowBurn: 1 }); // { severity: 'page', ... }
```

A burn rate of 1 spends the budget exactly at the end of the window. 14.4 spends a 30-day budget in
two hours — the number worth paging on.

Burn rate catches what a consumption threshold does not: a threshold fires once the damage is done,
a burn rate fires while it is happening. Two windows, because a single one either pages on
transients or misses slow bleeds.

## Pilot is not a commitment

`status` defaults to `pilot`. A pilot objective is measured and reported and is explicitly not
something anybody may rely on.

`validateObjective` refuses a `committed` objective below what its service's tier means, and
refuses a target of 100% — no budget means every deployment is a violation, and an objective nobody
can meet is an objective nobody uses.

It also catches an objective written against an `error_rate` indicator as though higher were
better. "error_rate >= 99.9%" reads plausibly and means the opposite of what its author intended;
the direction is a property of the indicator kind, so it is catchable rather than a matter of
review attention.

## Maintenance windows

Minutes inside an approved, SLO-excluded window are dropped before aggregation, so planned work
does not spend the budget kept for unplanned failure.

The exclusion is applied late, over intact counts, which makes it auditable: the same measurements
produce a different SLI depending on which windows were approved, and that dependency should be
visible.
