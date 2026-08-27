# Writing a policy

## The shape

```json
{
  "policyId": "api.quota",
  "name": "API quota",
  "description": "Decides whether a consumer may make another call against their allowance.",
  "category": "api",
  "version": "1.0.0",
  "owner": "usr_platform",
  "status": "draft",
  "rules": [
    {
      "ruleId": "deny-over-quota",
      "description": "Over the daily quota, calls are refused.",
      "priority": 10,
      "when": { "field": "callsToday", "operator": "gt", "value": 10000 },
      "effect": "deny",
      "reason": "The daily quota for this plan has been reached."
    },
    {
      "ruleId": "allow-within-quota",
      "description": "Within the quota, calls proceed.",
      "priority": 20,
      "when": { "field": "callsToday", "operator": "lte", "value": 10000 },
      "effect": "allow",
      "reason": "Within the daily quota."
    }
  ],
  "defaultEffect": "deny",
  "testCases": [
    { "name": "over the quota", "attributes": { "callsToday": 20000 }, "expect": "deny" },
    { "name": "within the quota", "attributes": { "callsToday": 5 }, "expect": "allow" }
  ],
  "effectiveDate": "2026-01-01T00:00:00.000Z",
  "reviewDate": "2026-12-31T00:00:00.000Z"
}
```

The condition tree is `@trustos/workflow-definition`'s `conditionSchema`, reused rather than
reimplemented. One predicate language across workflows, products and policies means one thing to
learn and one place where a comparison bug would live.

## Rules of thumb

**Write the reason for the person it refuses.** `reason` is quoted back to whoever was denied.
"Policy violation" tells them nothing; "the daily quota for this plan has been reached" tells them
what to do.

**Lower priority runs first.** Denials usually want lower numbers than allows, so a specific
refusal is reached before a general permission.

**A deny cannot carry obligations.** The schema refuses it. The action is not happening, so there
is nothing to oblige — and if the intent is "allow, but only if", the effect is `allow`.

**Test both outcomes.** Required by the schema when the policy can produce both.

## Checking it

```console
$ trustos policy validate policies.json
api.quota@1.0.0
  2 test(s) pass; static analysis is clean.
```

Static analysis reports four things a review misses:

- **`unreachable`** — a rule that can never match, usually because an earlier rule at the same
  priority always matches first.
- **`shadowed`** — a rule whose condition is fully covered by an earlier one.
- **`ambiguous_priority`** — two rules at the same priority whose conditions overlap, so which
  decides depends on the id tiebreak rather than on intent.
- **`no_effect`** — a rule whose effect matches the default, so removing it changes nothing.

## Simulating

```console
$ trustos policy simulate policies.json '{"callsToday":20000}'
DENY  api.quota@1.0.0
  rule deny-over-quota (priority 10) matched: callsToday > 10000
  The daily quota for this plan has been reached.
```

Exits 2 on a denial and 1 on an error, so a pipeline can tell "the policy said no" from "the file
was unreadable".

Simulate against a draft freely. The CLI enforces nothing.

## Versioning

Versions are immutable. Changing a policy means publishing a new version, and
`assertSufficientPolicyBump` checks the version moved far enough for what changed:

- a new rule, or a widened condition → **minor**
- a changed effect, a removed rule, or a narrowed condition → **major**

The reason is the decision log. A logged decision names a version; if that version's contents could
change, re-deriving the decision would produce a different answer, and the log would be a record of
something that never happened.
