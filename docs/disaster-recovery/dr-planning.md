# DR plans

A DR plan is not a longer runbook. A runbook says what to do; a DR plan additionally says **who
decides**, and the deciding is the part that fails.

Every DR story that goes badly has the same shape: the technical steps were known, and forty
minutes went by while people worked out whether they were allowed to take them.

## What a plan must contain

**A decision authority and a deputy.** The schema refuses a plan where they are the same. The
authority is unreachable during exactly the events this covers — that is what "disaster" means —
and a plan whose authority is one person is a plan that waits for them.

**A communication plan.** Audiences, channels, a spokesperson role and a cadence. Not courtesy:
during a region failure the loudest question is "is anyone working on this?", and answering it
badly generates a second incident made of people. The cadence matters because silence is read as
nobody working on it.

Channels have to work when the usual one may itself be down — a status page hosted inside the
failed region is not a status page.

**Failback.** Required, with data reconciliation. Failing over is half of it; running indefinitely
on the secondary is a decision nobody made, on infrastructure nobody sized, and the way back is
harder than the way out because the two sides have diverged.

**A data decision**, for the scenarios that need one.

## The scenarios and their traps

| Scenario                 | The trap                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `infrastructure_failure` | The recovery target usually shares a control plane with what failed.                                        |
| `database_corruption`    | Corruption replicates. The standby has it, and the last clean backup may be older than anybody assumes.     |
| `provider_outage`        | A provider returning _wrong_ answers is worse than one returning errors, and health checks pass throughout. |
| `region_failure`         | Claiming multi-region capability that has never been exercised.                                             |
| `credential_compromise`  | Restoring from backup restores whatever the attacker did.                                                   |
| `deployment_failure`     | A migration that ran. Code rolls back; a schema change does not.                                            |
| `data_corruption`        | The blast radius is a question, not a fact.                                                                 |

`credential_compromise` is the one people get wrong. The instinct is to restore from backup, and a
backup taken after the compromise contains whatever the attacker did. It needs a point in time
established _before_ the compromise, which means knowing when the compromise started — usually the
hard part, and almost never in the plan.

The schema requires `dataDecision` for every scenario where "restore the latest backup" is the
wrong answer, because the reason it is wrong takes a paragraph that nobody writes during the
incident.

## An unexercised plan is refused, with an override

```ts
assertActivatable({ plan });
// Refuses: "has never been exercised, so nothing is known about whether it works."

assertActivatable({ plan, force: { by, reason } });
// Permitted, with a reason of at least twenty characters.
```

The override exists because a real disaster is not the moment to be blocked by governance, and a
refusal with no override is simply worked around outside the system — taking the record with it.

The reason lands in the activation audit record, where it will be read during the review.

## What can honestly be claimed

```ts
readinessOf(plan).statement;
// "Exercised as a full failover in 42 minutes against a 60-minute RTO."
// "Exercised as a tabletop only. The procedure has been walked through, not run."
// "Never exercised. Nothing is known about whether this plan works."
```

Written to be quoted in a readiness scorecard, so the wording is careful. "DR tested" covering a
meeting is how a scorecard becomes fiction.

```ts
capabilityStatement(plans);
// "No region-failure plan exists. Multi-region recovery is not a capability this platform has."
// "Multi-region recovery is documented, not demonstrated."
// "Region failover has been exercised end to end in 42 minutes (docs/dr/evidence/...)."
```

This function exists for one line in the specification — _do not claim multi-region DR if it has
not been implemented_ — and for the summary sentence leadership reads, where the temptation to
round up is strongest.

## Gaps across the estate

```ts
reviewPlans({ plans, registry, procedures, restoreTests });
```

`scenario_uncovered` reports scenarios with no plan at all. That is the gap that does not show up
when plans are reviewed one at a time: every plan looks fine and the missing one is invisible.
