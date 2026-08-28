# Database migrations

Prisma migrations, version-controlled, immutable, and gated in CI.

## The rules

**Migration history is immutable.** Once a migration is merged, its file never changes — not to fix
a typo in a comment. Prisma records a checksum of every applied migration and `migrate deploy`
refuses against any database that ran a version with a different one. That refusal is correct: a
migration whose contents changed after it was applied means two databases with the same history
have different schemas.

This is why the destructive-migration gate uses a baseline file for migrations that predate it,
rather than asking for markers to be added to files that are already applied.

**Deployment never resets.** `prisma migrate deploy` applies pending migrations and nothing else.
`migrate reset` and `db push` are development commands and appear in no deployment path.

**One service migrates.** `trustos-api` carries `preDeployCommand`; no other service does. Seven
services each migrating on boot is seven concurrent attempts against one database.

## The commands

|                            |                                                                           |
| -------------------------- | ------------------------------------------------------------------------- |
| `npm run db:migrate`       | Development. Creates a migration from a schema change and applies it.     |
| `npm run db:deploy`        | Every other environment. Applies pending migrations. Never generates one. |
| `npm run db:validate`      | Checks the schema parses and the client is in sync.                       |
| `npm run migrations:check` | The safety gate. Runs in CI.                                              |
| `npm run db:seed`          | Demo data. Refuses in production by construction.                         |

## Writing one

```bash
# 1. Edit packages/database/prisma/schema.prisma
# 2. Generate and apply it locally.
npm run db:migrate -- --name add_merchant_category

# 3. Read the SQL Prisma generated. This is the step people skip.
cat packages/database/prisma/migrations/*_add_merchant_category/migration.sql

# 4. Check the gate.
npm run migrations:check
```

Step 3 matters because Prisma's inference is good and not infallible. A column rename is expressed
as a drop and an add unless you tell it otherwise, and the drop takes the data with it.

## The safety gate

`npm run migrations:check` refuses five patterns, each a way to lose data:

| Pattern                          | What it costs                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `DROP TABLE`                     | The table and every row in it                                                     |
| `DROP COLUMN`                    | The column and every value in it                                                  |
| `ALTER COLUMN ... TYPE`          | Values that do not cast cleanly. Widening is safe; narrowing truncates            |
| `SET NOT NULL`                   | Nothing — unless a row holds a null, in which case the deploy stops half-applied  |
| `DELETE` / `TRUNCATE` / `UPDATE` | Whatever the statement changes. A data migration is the one nobody reviews as one |

`SET NOT NULL` is the one people are surprised by. It destroys nothing and it fails at deploy time
against any null, leaving a database somebody now has to reason about under time pressure.

### Approving one

Two lines in the migration file:

```sql
-- trustos:destructive-approved reason="Column unused since v0.3; a query confirmed zero non-null rows"
-- trustos:destructive-approved-by usr_platform_lead

ALTER TABLE "Merchant" DROP COLUMN "legacyCategory";
```

Both are required, and the reason must be at least twenty characters. A marker with no reason is a
marker somebody pasted; the reason is what a reviewer reads six months later when they are working
out where the data went.

Comments are stripped before matching, so a pattern named in an explanatory comment is not a
finding. Without that, the comments a good migration carries would trip the check that exists to
make people write them.

### The baseline

`packages/database/prisma/migrations/.destructive-baseline.json` approves migrations that were
already applied when the gate was introduced. One entry: the phase-4 `RefreshToken.usedAt`
backfill, which is a write to one new column and is idempotent.

The baseline exists because **adding a marker to an applied migration would change its checksum**,
and Prisma would then refuse against every database that ran it. A check introduced to an existing
repository cannot ask for its history to be rewritten.

It is not an escape hatch: a new migration is checked against the marker rule, and the baseline is
matched by migration name against files that exist.

## The safe shape of a risky change

### Renaming a column

Never in one migration. Three deploys:

```text
1. Add the new column. Write to both. Deploy.
2. Backfill the new column from the old. Deploy.
3. Stop writing the old column. Deploy.
4. Drop the old column, with an approval marker. Deploy.
```

Each step is reversible on its own. The one-migration version is reversible only from a backup.

### Making a column required

```text
1. Add it nullable, with a default. Deploy.
2. Backfill. Verify zero nulls.
3. SET NOT NULL, with an approval marker. Deploy.
```

Step 2's verification is the point. `SET NOT NULL` against a table with one null fails halfway
through the deploy.

### Changing a type

Add a new column of the new type, backfill with an explicit cast you have tested, switch reads,
then drop. An `ALTER COLUMN ... TYPE` performs the cast the database chooses, and a `numeric` to
`integer` cast truncates silently.

## Per environment

### Development

```bash
npm run db:migrate
```

Generates and applies. Reset freely: `npx prisma migrate reset --schema packages/database/prisma/schema.prisma`.

### DEV and UAT on Railway

Applied by `trustos-api`'s `preDeployCommand`. Nothing manual.

If it fails, the deploy fails and the previous version keeps serving — which is the correct
outcome, and it is why the migration runs _before_ the new image takes traffic rather than inside
its start-up.

### Production

Documented, not automated.

```text
1. Take a backup and verify it restores. See evidence/restore-test.md.
2. Read the migration SQL. Again.
3. Apply it in a maintenance window, with somebody watching.
4. Verify the row counts and the application's readiness.
5. Deploy the code.
```

Step 1 is the one that gets skipped, and the only one that helps at step 4 when something is wrong.

## When a migration goes wrong

**Forward, not backward.** Prisma has no `migrate down`, deliberately, and rolling a schema back is
how a partially-applied migration becomes two partially-applied migrations.

| Situation                     | What to do                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| It failed and applied nothing | Fix the migration, redeploy. Nothing happened.                                                                                               |
| It failed halfway             | `prisma migrate resolve --rolled-back <name>`, then a **new** migration that reaches the intended state from where the database actually is. |
| It applied and was wrong      | A **new** migration that corrects it. Never edit the applied one.                                                                            |
| It destroyed data             | Restore from backup. This is the case the gate exists to prevent, and the only one where the backup is the answer.                           |

The last row is why the gate refuses rather than warns.
