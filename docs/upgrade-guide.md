# Upgrade guide

How to move a deployment forward, and what the framework does to make that a plan rather than a
leap.

---

## 1. The short version

```bash
trustos platform info                    # where you are, and what needs attention
trustos upgrade --to 0.6.0 --dry-run     # what would happen
trustos upgrade --to 0.6.0               # do it
```

The dry run is **not calling apply**. It is the same code path producing the same plan object; the
difference is printing it instead of handing it to an executor. A tool with two paths stops
predicting the real run the first time they diverge.

---

## 2. What the preflight checks, and in what order

Cheapest failures first, so nothing is touched before the obvious problems surface.

1. **Direction.** A downgrade is refused outright. Migrations run forward — a schema migrated to
   0.6 does not un-migrate by installing 0.5. To go back you _restore_.
2. **Support.** Is the target released, and not withdrawn?
3. **Compatibility.** Evaluated against the **target** version, not the current one. The question
   is whether things work _after_ the upgrade.
4. **Dependencies.** Does the module graph still resolve? Cycles, missing dependencies and version
   conflicts all block.
5. **Migrations.** What would run, is any of it destructive, is there a backup?

Steps 1–4 cost nothing. Step 5 is where the mandatory backup lives, because that is the last
moment it is still free.

---

## 3. Backups and rollback

**How to recover is decided before the upgrade starts.** Deciding it at failure time, with a
half-migrated database, is deciding it under the worst possible conditions.

| Situation                          | Recovery                     |
| ---------------------------------- | ---------------------------- |
| Every applied migration reversible | Reverse them, newest first   |
| Anything irreversible applied      | Restore from the backup      |
| Irreversible applied, no backup    | **Nothing.** Manual recovery |

A **destructive plan without a backup is refused**, not warned about. The most expensive failure
available is a destructive migration run against production with nothing to restore from, and it
happens because a warning scrolled past.

The migration that _threw_ is treated as possibly-partially-applied even though it never finished.
A database migration that failed halfway may already have dropped a column, and treating "not
recorded as applied" as "nothing happened" is how a recovery reports success over a mangled
schema.

### Why there is no `down` for database migrations

`migrationSchema` refuses `reversible: true` on a destructive migration. A dropped column does not
come back, and a backfill that merged two fields cannot be unmerged. A `down` script that claims
otherwise is worse than none, because it is trusted.

Config, template and module migrations _are_ reversible: the previous file can be restored.

---

## 4. Reading the plan

```
0.4.0 → 0.6.0. 7 migration(s) (5 database, 2 config), roughly 4 minute(s).
Contains destructive changes — a backup is mandatory and rollback means restore.
2 warning(s) to read first.
```

| Line                                            | Means                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `FAIL compatibility:module`                     | A module will not work on the target. Blocks                     |
| `FAIL dependencies:cycle`                       | The graph does not resolve. Blocks                               |
| `FAIL backup`                                   | Destructive, and nothing to restore from. Blocks                 |
| `WARN breaking-changes`                         | Each one needs a change on your side                             |
| `WARN support`                                  | The version you are on is out of support — overdue, not optional |
| `WARN compatibility:module … not been verified` | Declared compatible, never tested together                       |

Being out of support **warns rather than blocks**. It is the reason to upgrade; blocking on it
would trap exactly the deployments that most need to move.

---

## 5. Upgrading in steps

The framework does not require it, and you should do it anyway once the gap is more than one
minor.

Each step crosses fewer migrations, and when one fails you know which release caused it. A single
jump across a year of releases fails somewhere in the middle with a plan too large to reason
about.

```bash
trustos upgrade --to 0.5.0 && trustos upgrade --to 0.6.0
```

`framework-health` reports the gap: over 180 days is degraded, over 365 is unhealthy. A platform
nobody upgrades is a platform nobody _can_ upgrade.

---

## 6. Upgrading modules and templates

**Modules** move with `trustos update`, which produces the same kind of plan. A plan that would
move an installed module _backwards_ to satisfy a new one is refused: a silent downgrade of
something that was working, to accommodate something just added, is a change nobody chose.

**Templates** are different — a generated project has no runtime dependency on the template it
came from, so a template moving on does not affect it. `trustos update-template` reports what
changed and there is no automatic apply, because by now you have edited most of what the template
wrote and re-rendering over your work would clobber it.

---

## 7. After an upgrade

```bash
trustos platform info        # health, compatibility, anything left
trustos doctor               # the machine
trustos doctor template      # still matches the template it came from
```

Keep the upgrade report. It records what was applied, what failed, and whether a rollback
happened — and it is what a change record wants.

---

## 8. When it goes wrong

**The plan refuses to run.** Read the blocking findings; each carries a remediation. Nothing has
been touched.

**A migration fails and it rolled back.** You are on the version you started from. The report names
the migration and the error.

**A migration fails and it did not roll back.** The report says so plainly rather than claiming
success. The system is between versions: restore the backup, then work out what happened before
retrying. Do not run the upgrade again against a half-migrated schema.

**It succeeded but something is broken.** `trustos platform info` first — a module that was
`unknown` in the compatibility check is the usual answer. Record the result in the matrix either
way, so the next deployment gets a real verdict instead of a guess.
