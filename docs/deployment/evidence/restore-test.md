# Restore test

§26 of the readiness specification: **performed**, not documented as a procedure.

A backup was taken, restored into an isolated database, validated, and the application started
against the restored data with the full smoke suite re-run.

## Environment

|             |                                       |
| ----------- | ------------------------------------- |
| Database    | PostgreSQL 17, local, `trustos_smoke` |
| Tool        | `pg_dump -Fc` and `pg_restore`        |
| Application | `api-example`, `NODE_ENV=production`  |
| Ran         | 2026-08-27                            |

**What this is not.** It is a restore test against a local PostgreSQL, not against Railway's
managed backups. Railway's own backup and restore has not been exercised, and the readiness
scorecard says so. What this establishes is that a TrustOS database _can_ be dumped, restored and
served from — which is the part the framework is responsible for.

## Timings

| Step                                            | Measured         |
| ----------------------------------------------- | ---------------- |
| Backup                                          | **111ms**        |
| Backup size                                     | **244 KB**       |
| Restore                                         | **188ms**        |
| Application start against the restored database | **1,061ms**      |
| **Total, backup to serving traffic**            | **~1.4 seconds** |

The numbers are small because the database is small — 4 users, 2 organizations, 12 audit records.
They are the right shape and the wrong magnitude for a production estate, and the readiness
scorecard does not treat them as an RTO.

`@trustos/recovery`'s rule applies: the measured restore time should be taken from the **slowest**
successful run, because that is the run that coincides with the incident. One run at this size
establishes that the procedure works, not how long it takes.

## Validation

| Check                     | Result                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| `database_restored`       | **pass** — `pg_restore` exited clean                                              |
| `schema_matches`          | **pass** — 82 tables, identical to the source                                     |
| `row_counts_plausible`    | **pass** — users 4, organizations 2, members 5, audit 12, roles 5 — all identical |
| `referential_integrity`   | **pass** — the application queried across joins without error                     |
| `application_starts`      | **pass** — booted in 1,061ms                                                      |
| `health_check_passes`     | **pass** — `/ready` returned 200                                                  |
| `audit_chain_intact`      | **pass** — see below                                                              |
| `sample_records_readable` | **pass** — login and an authorized read both succeeded                            |

Migration history restored intact: **9 migrations, all with a `finished_at`**. A restored database
whose `_prisma_migrations` is empty would accept every migration again on the next deploy.

### Audit integrity, specifically

The append-only trigger survived the restore, and still enforces:

```text
UPDATE "AuditLog" SET action='tampered';
ERROR:  AuditLog is append-only: UPDATE is not permitted

DELETE FROM "AuditLog";
ERROR:  AuditLog is append-only: DELETE is not permitted
```

This is the check most worth having and the one most easily missed. `pg_dump` restores tables,
indexes, constraints **and** triggers — but a restore performed with `--data-only`, or into a
schema created by `prisma db push` rather than by the migrations, would produce a database with
every row present and the append-only guarantee gone.

The audit trail would then be silently mutable, and nothing about querying it would say so.

## Smoke tests against the restored database

**10 passed, 0 failed, 1 skipped** — identical to the run against the source database.

The skip is the AI gateway, which is not configured.

Report: [`smoke-report-restored.json`](smoke-report-restored.json).

## What this establishes, and what it does not

**Establishes:** a TrustOS database can be dumped, restored into a fresh database, and served from,
with the schema, the data, the migration history and the append-only guarantee intact.

**Does not establish:**

- That **Railway's** backup and restore works. It has not been exercised. Railway takes its own
  backups and restoring one is a different procedure with different failure modes.
- **How long a real restore takes.** 188ms on 244 KB says nothing about a production estate. Any
  RTO derived from it would be the "estimate that is always shorter than the run" that
  `@trustos/recovery` warns about.
- That a **point-in-time** restore works. `pg_dump` is a snapshot; recovering to a moment between
  snapshots is Railway's WAL retention, and that has not been tested.

## Reproducing it

```bash
# 1. Back up.
pg_dump -Fc -f backup.dump "$DATABASE_URL"

# 2. Restore into an isolated database. Never into the source.
createdb trustos_restore
pg_restore -d trustos_restore backup.dump

# 3. Validate the schema and the migration history.
psql -d trustos_restore -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
psql -d trustos_restore -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;"

# 4. Validate the audit guarantee, which is the one a data-only restore loses.
psql -d trustos_restore -c "UPDATE \"AuditLog\" SET action='x';"   # must ERROR

# 5. Serve from it, and re-run the smoke tests.
DATABASE_URL=postgresql://.../trustos_restore node apps/api-example/dist/main.js &
TRUSTOS_BASE_URL=http://localhost:3000 npm run smoke
```

Step 4 is the one to keep. Steps 1 through 3 tell you the bytes came back; step 4 tells you the
guarantees did.
