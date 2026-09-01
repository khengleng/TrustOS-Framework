# Retention

The longest applicable retention wins, the gentlest action wins, and a legal hold beats both with
no override parameter.

## Deciding

```ts
decideRetention({ entry, rules, now });
```

When several rules apply, the decision takes the **longest minimum**, the **shortest maximum** that
is still above that minimum, and the **gentlest action**.

Longest minimum, because a rule saying "keep for seven years" and one saying "keep for one year"
are not in conflict — the first is a floor and deleting at one year violates it.

Gentlest action, because `anonymize` and `delete` both satisfy a retention limit, and choosing
`delete` when a rule permitted anonymization destroys data somebody could have kept using. The
reverse mistake is recoverable; this one is not.

## Legal hold has no override

```ts
assertDeletable({ entry, decision, holds, now });
```

Takes a single input object. There is deliberately **no** `override` parameter, no `force` flag and
no `ignoreHolds` option.

This is the one place in the layer with no escape hatch, and the reason is specific: a legal hold
exists because somebody outside the company — a regulator, a court, opposing counsel — has said
this data must not be destroyed. An override parameter would be a code path that destroys evidence
under legal preservation, and its existence is the problem regardless of who can reach it.

A deployment that genuinely needs to delete held data resolves the hold first, which is a decision
with a name attached.

## Retention is a floor and a ceiling

A retention rule has both `minimumDays` and `maximumDays`. The floor is a regulator; the ceiling is
a data protection obligation, and they pull in opposite directions.

The schema refuses a rule whose minimum exceeds its maximum. That combination is not a
configuration to reconcile at runtime — it is two obligations that cannot both be met, and somebody
has to decide which applies before the system runs.

## Default retention comes from the classification

`obligationsFor(level).defaultRetentionDays` is the starting point when no rule applies: 365 days
for `PUBLIC` up to 3650 for `HIGHLY_RESTRICTED`.

`@trustsystem/backup` reads the same number, which is why a backup retained for 30 days at
`HIGHLY_RESTRICTED` is reported as a finding rather than accepted.
