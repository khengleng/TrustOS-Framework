# Incidents

An append-only timeline, a closing gate, and a severity nothing derives.

## Severity is never derived

`@trustsystem/incident-management` will not guess a severity from symptoms. Severity is a judgement
about impact, and a rule that derived it would be wrong often enough that people would start
overriding it — at which point the recorded severity means nothing.

|      | Meaning                                                | Postmortem | Pages |
| ---- | ------------------------------------------------------ | ---------- | ----- |
| SEV1 | Customers cannot transact, or money is at risk.        | required   | yes   |
| SEV2 | A major function is unavailable or needs a workaround. | required   | yes   |
| SEV3 | Degraded or partially impaired.                        | no         | no    |
| SEV4 | Minor or cosmetic, no customer impact.                 | no         | no    |

Reassessing is always permitted — the first assessment is made with the least information anyone
will have — and never silent: the reason lands on the timeline.

## The timeline is append-only

Every mutation returns a new incident rather than editing one in place, which makes append-only
structural rather than a convention somebody remembers.

There is no route that edits or removes an entry, in the package or in the console.

An editable timeline is a timeline that gets tidied before the review, and the details that get
tidied away — the wrong hypothesis pursued for forty minutes, the alert nobody saw — are the ones a
postmortem exists to find.

Entries carry both `occurredAt` and `recordedAt`. The gap is interesting: it is how long nobody was
recording.

## Transitions

```text
detected → investigating → identified → mitigated → resolved → closed
```

Backwards moves as far as `investigating` are allowed, because mitigations fail and re-opening is
more honest than opening a second incident that splits the timeline in two.

Jumping from `detected` to `resolved` is not allowed. Something was done, and the record should say
what. A mitigation must describe itself, and so must a resolution — one that cannot be described
cannot be reused next time.

## The closing gate

A SEV1 or SEV2 closes only with a postmortem whose corrective actions have owners and due dates.

This is the one thing the package refuses that an operator might reasonably want, and it refuses it
because "monitor and see" is how the same incident happens twice — and the second time, nobody
remembers the first.

The postmortem schema is blameless by construction: it asks for `contributingFactors`, which is a
question about the conditions that made the failure possible, rather than about who did what.

Corrective actions declare a `kind`: `prevent`, `detect_faster`, `mitigate_faster`,
`reduce_impact`, `documentation`. All are legitimate. A postmortem consisting entirely of
`detect_faster` has not found a cause, and stating the kind makes that visible.

Cancelling an action is allowed; cancelling silently is not.

## What the review reads

```ts
incidentMetrics(incident);
// { timeToMitigateMinutes: 41, timeToResolveMinutes: 60, customerDetected: false }
```

`customerDetected` is the most useful line in a tier-1 review, and it is a fact rather than an
opinion: the incident recorded how it was found.

```ts
overdueActions(incidents, asOf);
```

The list nobody maintains and everybody needs. Postmortem actions decay quietly, and the same
incident recurs while its prevention sits at 20% done — at which point the second postmortem writes
the same action again.

## Impact is stated in customer terms

`impact` is required and is about what customers cannot do. `affectedProducts` is filled from the
service registry rather than typed, so an impact statement cannot go stale as the estate changes.

Stating impact as "the payments service is red" is how a status page says nothing useful.
