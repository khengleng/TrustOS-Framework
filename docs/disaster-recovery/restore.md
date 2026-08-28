# Restore procedures and restore tests

The distinction between the two words is the package.

A restore **procedure** is a document. A restore **test** is an event with a duration, a result and
a report. The specification is explicit that one does not substitute for the other: _a backup that
has never been successfully restored must not be marked fully validated._

## A restore test never targets production

`targetEnvironment` accepts `isolated`, `development` or `staging`. Never production.

A restore test that writes to production is not a test — it is an outage with a rehearsal attached.
This is the one refusal here that would be inconvenient to work around, which is the point.

`isolationNotes` is required, so a reader can judge whether the target really was isolated rather
than taking the word for it.

## The checks are individually recorded

| Check                     | Required | Establishes                                               |
| ------------------------- | -------- | --------------------------------------------------------- |
| `database_restored`       | yes      | The dump loaded without error.                            |
| `schema_matches`          | yes      | The schema matches what the application expects.          |
| `row_counts_plausible`    | yes      | Counts are within the expected range of the source.       |
| `referential_integrity`   | yes      | Nothing references a row that did not come back.          |
| `application_starts`      | yes      | The application boots against the restored data.          |
| `health_check_passes`     | yes      | Readiness reports healthy.                                |
| `ledger_balances`         | yes      | Every restored journal entry still balances.              |
| `audit_chain_intact`      | yes      | The restored audit records are contiguous and unmodified. |
| `sample_records_readable` | no       | A sample of business records reads end to end.            |

`ledger_balances` is non-negotiable for a financial platform. A restored ledger that does not
balance is corrupt data presented as a recovery, and the corruption is discovered later by a
reconciliation nobody connects to the restore.

A single pass/fail would hide exactly that.

## A check that was not performed is not a check that passed

```ts
evaluateRestoreTest(test);
// { succeeded: false, failedChecks: [], missingChecks: ['ledger_balances'], ... }
```

Reported separately from a failure. Treating them the same lets a test pass by omitting the check
it would have failed, and the omission is invisible in a summary that counts only failures.

## The duration is measured

From the timestamps, not estimated. An RTO derived from "the restore takes about an hour" is a
number nobody has checked, and the checking always finds it is longer: the index rebuild nobody
counted, the application that will not start until a migration runs.

```ts
measuredRestoreMinutes(tests, 'postgresql');
// { minutes: 120, fromTestId: 'rt_20260401', sampleSize: 3 }
```

Returns the **slowest** successful test, not the fastest or the mean. An RTO set from the best run
is an RTO met once; the number that matters is what happens when the restore is slow, because that
is the run that coincides with the incident.

## Completing the backup record

```ts
const outcome = assertTestValidates({ test, backup });
inventory.recordRestoreTest({ backupId, restoreTestId: outcome.restoreTestId, at });
```

The gate between the two packages: a backup's strongest claim can only be set from an event that
actually happened, and `recordRestoreTest` takes the test id so the claim has evidence behind it.

`assertTestValidates` refuses a test that did not fully succeed. A restore test that partially
succeeded is useful information and is not evidence that the backup can be restored.

## Procedures go stale

```ts
reviewProcedures({ procedures, tests, at });
// never_exercised | stale_procedure | no_measured_duration
```

`never_exercised` is the high-severity one. A procedure written eighteen months ago and never
followed refers to a console that has been redesigned, a role that was renamed and a command that
no longer exists — and none of that is visible from reading it.

`no_measured_duration` means no step has been timed, so any RTO derived from the procedure is an
estimate. The estimate is always shorter than the run.
