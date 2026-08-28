# Backups

One sentence in the specification determines the whole design: _do not assume backup success from
job completion alone._

A job that exits zero has written bytes somewhere. It has not established that the bytes are
complete, that they are readable, that they are encrypted, or that anything can be reconstructed
from them — and every one of those has failed in production somewhere while the job kept reporting
success.

## Four independent claims

```ts
assuranceOf(backup);
// { completed, checksumVerified, contentsVerified, restoreTested, fullyValidated, outstanding }
```

| Claim              | What it establishes                                                          |
| ------------------ | ---------------------------------------------------------------------------- |
| `completed`        | The job finished. The weakest claim, and the only one a job can make itself. |
| `checksumVerified` | The bytes read back match what was written. Catches truncation and bit rot.  |
| `contentsVerified` | The backup was inspected — row counts, schema, expected tables.              |
| `restoreTested`    | A restore was performed and the result checked.                              |

`fullyValidated` requires all four. A backup that has never been restored from is a **hypothesis**,
and `describeAssurance` says so in those words, because this is the surface a readiness scorecard
quotes from.

They are separate fields rather than one status enum, because an enum forces an ordering and
somebody eventually sets it to `verified` from the job runner that only knows about `completed`.

## The inventory keeps failures

A backup inventory that only records successes cannot answer the question that matters after an
incident: _when did this last work, and how many times did it fail before anybody noticed?_

The schema refuses a record that both completed and failed.

## Findings

| Finding                          | Severity | Why                                                       |
| -------------------------------- | -------- | --------------------------------------------------------- |
| `never_restored`                 | high     | An untested assumption rather than a recovery capability. |
| `same_failure_domain`            | high     | Whatever takes out the source takes out the backup.       |
| `failed`                         | high     | The job did not complete.                                 |
| `no_checksum`                    | medium   | Truncation is undetectable without one.                   |
| `stale`                          | medium   | Older than the source's maximum age.                      |
| `retention_below_classification` | low      | Shorter than the classification's default.                |

`sameFailureDomain` is a declared boolean rather than something inferred from a path, because the
inference is unreliable and the consequence is discovered during the outage.

## Per-source requirements

The database and the audit archive both require a checksum. An audit trail is append-only and
legally significant, so a copy that cannot be shown to be unmodified is not evidence of anything.

`secrets_metadata` backs up _which_ secrets exist, where and when they rotate — never their values.
A backup containing secret values is a second place they leak from, and it is usually the place
with the weakest access controls.

## Encryption states how

The schema refuses `encrypted: true` without `encryptionMethod`. "Encrypted" covers both a managed
volume and an encrypted archive, and only one of those survives somebody copying the volume.

## From the CLI

```console
$ trustos backup status backups.json
Backups — 3

  bk_pg_20260601: completed, checksummed, inspected and restored from on 2026-05-15.
  bk_files_20260601: the job completed. Nothing has ever been restored from it, so it is a
    hypothesis rather than a backup.
  bk_pg_20260531: Out of disk on the backup volume.
```

Prints the statement rather than a status word. "Healthy" would be shorter and would let a reader
conclude that a job which exited zero is a backup they can restore from.

```console
$ trustos backup verify backups.json
```

Does not verify anything — it reports what has been verified, and says so in its output. Verifying
means reading the backup back and restoring it, which needs the backup, a target and the time, none
of which a CLI on a laptop has.
