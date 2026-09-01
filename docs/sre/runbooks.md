# Runbooks and the service registry

## A service with no owner does not register

That is the single structural rule in `@trustsystem/sre-core`, and everything else follows from it. An
unowned service is one whose alerts route nowhere; it is better for that to fail at registration,
in daylight, than during the incident.

Above tier 3, a service also names an on-call rotation and at least one runbook. A tier-1 service
with no rotation is refused by the schema.

## Tiers mean something

| Tier     | Meaning                                     | Min availability | Runbook  | On-call  |
| -------- | ------------------------------------------- | ---------------- | -------- | -------- |
| `tier_1` | Customer-facing or money-moving.            | 99.9%            | required | required |
| `tier_2` | Internal or supporting. Minutes, not hours. | 99.5%            | required | —        |
| `tier_3` | Batch, reporting, development.              | 99.0%            | —        | —        |

A deployment overrides these; it does not get to leave them undefined, because an undefined tier is
how everything becomes tier 1.

## The findings that matter

**Tier inversion.** A tier-1 service critically depending on a tier-3 one has an availability
ceiling below its own objective, so the objective is arithmetic fiction. This is the most common
way a well-intentioned SLO becomes undeliverable, and it is invisible when services are reviewed
one at a time — each looks reasonable alone.

A _non-critical_ dependency on a lower tier is fine. That is what `critical: false` claimed, and
the analysis honours it.

**Dependency cycles.** Two services each critically depending on the other cannot be recovered
independently, so neither has a working recovery procedure.

**Unregistered dependencies.** A dependency on something the registry does not know about is a
dependency whose health is unmonitored.

## Who else is affected

```ts
registry.dependents('ledger.api'); // ['payments.api', 'settlement.batch']
```

The question asked in every incident and answered accurately by nobody from memory once there are
more than a dozen services.

Read from the registry rather than from health probes, deliberately: during an incident the
question is "what is affected", not "what has already alerted".

## Runbooks

Every step states an `action` and a `verification`. A step nobody can confirm is a guess, and at
3am a guess that looked like it worked is worse than a failure.

`escalateTo` is required. Escalation is part of the procedure, not the absence of one.

`lastReviewedAt` is required and reported when stale. A runbook written eighteen months ago refers
to a console that has been redesigned, a role that was renamed and a command that no longer exists
— and none of that is visible from reading it.

The trigger is written in the words an alert would use, so a responder can match what they are
seeing to the right document without reading all of them.

## Maintenance windows

A window is a governed object — approved by somebody, bounded in time, attached to named services —
rather than a note in a calendar, because its purpose is arithmetic: minutes inside it are excluded
from availability, so planned work does not consume the error budget.

A window declared for communication only sets `excludeFromSlo: false` and still measures.
