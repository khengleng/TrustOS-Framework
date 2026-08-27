# API versioning

The instruction is _avoid breaking consumers silently_, and one word does the work.

Breaking consumers is sometimes necessary. Doing it _silently_ is the failure, and it happens
through a specific mechanism: a change that is obviously breaking gets a major version and a
migration plan, while a change that is **nearly** compatible gets shipped as a patch because it
seemed harmless.

Removing an optional field. Tightening a validation rule. Adding a required scope.

## Every difference is classified

```ts
analyseCompatibility(from, to);
// { breaking: true, requiredBump: 'major', versionSufficient: false, changes: [...] }
```

| Change                   | Compatibility |
| ------------------------ | ------------- |
| `operation_removed`      | breaking      |
| `path_changed`           | breaking      |
| `method_changed`         | breaking      |
| `scope_added`            | **breaking**  |
| `authentication_changed` | breaking      |
| `idempotency_changed`    | breaking      |
| `classification_lowered` | **breaking**  |
| `classification_raised`  | compatible    |
| `scope_removed`          | compatible    |
| `operation_deprecated`   | compatible    |
| `operation_added`        | additive      |

Three of those are worth explaining, because the intuitive answer is wrong.

**`scope_added` is breaking.** A newly required scope means every existing credential lacks it, so
every existing consumer starts receiving 403s — from a change that alters no response and reads
like a security improvement.

**`classification_lowered` is breaking**, in the direction nobody expects. A consumer's access was
granted against the old classification, and lowering it changes which policy applies to data that
has not itself become less sensitive. It should be a deliberate reclassification, reviewed, rather
than a side effect of a version bump.

**`idempotency_changed` is breaking**, because callers built retry behaviour on the old answer. An
operation that stops being idempotent turns those retries into duplicates.

## Operations are matched by id, not by path

A renamed path is reported as a `path_changed` on the same operation rather than as one removal and
one addition. The difference matters: a removal-plus-addition reads as "the old one is gone", which
understates a move.

## A breaking change cannot ship as a patch

```ts
assertReleasable({ analysis, plan, knownConsumerIds });
```

Refuses when the version bump is insufficient. This is a code path rather than a review comment,
which is the point — the change that ships as a patch is the one that read as harmless in a diff.

## What a breaking change owes

A migration plan with:

- **A migration guide.** Concrete. A plan a consumer cannot follow is an announcement.
- **A deprecation period.** At least 90 days, or a recorded reason and an approver — sometimes a
  security fix cannot wait, and somebody still signs for it.
- **A named impact per consumer.** "All consumers should review" is not an impact assessment.
- **Notification.** `assertReleasable` refuses when a consumer has not been told.

## Chasing the ones who have not moved

```ts
unacknowledgedConsumers(plan, asOf);
// [{ consumerId: 'con_partner_a', daysSinceNotified: 92, impact: '...' }]
```

What turns a deprecation from a date into a conversation. A consumer notified ninety days ago who
never acknowledged has almost certainly not read it.

## From the CLI

```console
$ trustos api compatibility v1.json v2.json
1.0.0 → 1.0.1: 1 breaking. Requires a major version.

  path_changed (listMerchants): listMerchants moved from /api/merchants to /api/v2/merchants.
    consumers: Update the request path.

  These changes require a major version. 1.0.0 → 1.0.1 is not one.
```

Exits non-zero, so it runs in CI on every API change.
