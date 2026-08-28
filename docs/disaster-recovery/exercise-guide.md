# Running a DR exercise

## Three kinds, and they establish different things

| Kind       | What it proves                        | What it does not                     |
| ---------- | ------------------------------------- | ------------------------------------ |
| `tabletop` | People know the plan and can find it. | That the commands work.              |
| `partial`  | One component recovers.               | That the whole recovers together.    |
| `full`     | The procedure runs end to end.        | That it runs during a real incident. |

All three are worth doing. Only `full` produces a number an RTO can be checked against, and
`readinessOf` says which kind was run rather than reporting a boolean.

## Before

**Announce it.** An exercise nobody was told about produces a real incident response, which is
expensive and teaches the wrong lesson.

**Do not run during an open incident.** `@trustos/resilience-testing` refuses experiments then, and
the same applies here: a rehearsal during an incident is indistinguishable from the incident in the
timeline afterwards.

**Write the abort condition down.** An exercise that cannot say what "too far" looks like has no
way to stop, and the person watching it is deciding under time pressure whether what they are
seeing is the exercise or a real problem.

## During

**Time it.** `achievedMinutes` is the whole point of a full exercise. An exercise with no recorded
duration leaves the RTO unverified, and `readinessOf` says so.

**Follow the written procedure, not what you know.** The value of an exercise is finding where the
procedure is wrong. Somebody who knows the system routing around a broken step proves the person
can recover the system, which was not in doubt.

**Record what went slowly.** The step that took nineteen minutes and is documented as "run the
restore" is the finding.

## After

```ts
{
  exerciseId: 'ex_20260401',
  performedAt: '2026-04-01T00:00:00.000Z',
  kind: 'full',
  achievedMinutes: 42,
  succeeded: true,
  findings: ['The DNS change took eleven minutes to propagate, which the plan assumed was instant.'],
  evidenceRef: 'docs/dr/evidence/2026-04-01-region-failover.md'
}
```

**Findings are expected.** An exercise with no findings was not looked at hard enough. The first
full exercise of any plan finds several.

**`evidenceRef` points at what was produced.** A claim of DR capability rests on it, and
`capabilityStatement` quotes it.

## Checking the claim

```console
$ trustos dr validate dr-plans.json
Can these plans be claimed as tested?

  dr.region-failure: exercised as a walkthrough only — read, not run.
  dr.credential-compromise: never exercised, so nothing is known about whether it works.

  A DR capability is what has been demonstrated, not what has been written down.
```

Exits non-zero. Run it before anybody writes a readiness report.

## What a real disaster teaches that an exercise cannot

An exercise runs at a planned time, with the right people awake, on a system that is otherwise
healthy. A real one does not.

That gap is why `readinessOf` reports what was demonstrated rather than declaring the plan proven,
and why the framework never marks a DR item as passing on the strength of an exercise alone. The
exercise raises confidence; it does not settle the question.
