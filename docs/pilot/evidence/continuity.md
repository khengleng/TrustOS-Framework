# Backup, restore and DR

## Result: NOT PERFORMED

No backup was taken. No restore was performed. No DR exercise was run.

This page exists because the pilot specification asks for all three, and because reporting them as
"not applicable" or quietly omitting them would be the exact failure the framework's continuity
packages were written to prevent.

## Why

**There is no database.** The pilot runs in a test process against in-memory stores. Every port has
a Prisma implementation in the framework and the pilot binds none of them, so there is nothing to
back up.

**There is no deployment.** No environment exists to fail over, so there is nothing to exercise a
recovery procedure against.

## What the framework would say

`@trustos/backup` requires four independent claims before a backup is `fullyValidated`:

```text
completed        the job finished
checksum         the bytes read back match what was written
verified         the contents were inspected
restored         a restore was performed and the result checked
```

This pilot can make **none** of them.

`describeAssurance` on a backup with only the first would print:

> the job completed. The bytes have not been read back and compared. The contents have not been
> inspected. Nothing has ever been restored from it, so it is a hypothesis rather than a backup.

`capabilityStatement` in `@trustos/disaster-recovery`, given no plans, returns:

> No region-failure plan exists. Multi-region recovery is not a capability this platform has.

Both sentences are the honest ones and both are what this pilot carries.

## Why the scorecard says FAIL rather than PARTIAL

PARTIAL would mean something was partly demonstrated. Nothing was.

Scoring these PARTIAL on the strength of the framework _having_ a backup package would be exactly
the rounding-up that `describeAssurance` was written to make impossible, and it would be incoherent
to build a package whose entire design is "do not claim a backup works without a restore" and then
claim a backup works without a restore in the first report that uses it.

## What has to happen before the next pilot

1. **Bind the Prisma stores** and run the pilot against a real database.
2. **Take a backup.** Record it in `@trustos/backup` with its source, scope, location, encryption
   method, classification and retention.
3. **Verify it.** Read the bytes back and compare the checksum; inspect the contents.
4. **Restore it** into an isolated target — never production, which `@trustos/recovery` refuses —
   and run the nine checks, including `ledger_balances` and `audit_chain_intact`.
5. **Record the restore test**, which moves the backup to `fullyValidated` and moves Backup off
   FAIL.
6. **Run a DR exercise**, even a tabletop — and record it as a tabletop, which `readinessOf` will
   correctly describe as _"exercised as a walkthrough only. The procedure has been walked through,
   not run."_

Only step 5 changes the Backup score. Only a **full** exercise with a recorded duration changes the
DR score to anything above "documented, not demonstrated".
