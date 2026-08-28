# Module versioning

## Three versions, and what each one governs

| Version            | Where                                                            | Governs                                                                             |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Framework version  | root `package.json`, recorded in an application's `trustos.json` | Whether a module can be installed at all: each declares a `minimumFrameworkVersion` |
| Module version     | the module's catalog entry                                       | Whether one module satisfies another's dependency range                             |
| Application record | `trustos.json` `modules[]`                                       | Which module versions an application was installed with, and when                   |

`trustos add-module` checks the first two before it writes anything. A module needing
a newer framework than the application records is refused with both numbers in the
message, and a dependency whose catalog version falls outside the declared range is
refused the same way.

## Ranges

Only two forms are accepted in a module dependency:

```
0.1.0     exactly this version
^0.1.0    caret range
```

Richer ranges (`>=`, `||`, `x`) exist to express uncertainty about what a dependency
will do. A module graph that is resolved at install time, from one catalog, in one
reviewed repository, has no use for that uncertainty — and every extra form is
another way to write something whose resolution nobody can predict by reading it.

Caret follows npm, **including the pre-1.0 rule**: `^0.2.3` allows `0.2.x` but not
`0.3.0`. Every module here is still `0.x`, so treating `^0.1.0` as "any 0.x" would
let a breaking `0.2.0` satisfy a dependency that was reviewed against `0.1.x`. There
is a test for exactly that case.

## What counts as breaking

The parts of a module that other things depend on are not only its TypeScript types.

### Always breaking — requires a major (or, pre-1.0, a minor)

| Change                                               | Why                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Renaming or removing a **permission key**            | A role granting the old key silently loses access; a role granting the new one silently gains it |
| Renaming or removing an **audit action**             | Dashboards, alert rules and regulatory exports reference the string, sometimes for years         |
| Renaming or removing a **feature flag key**          | The flag evaluates to off, and the feature it gated disappears without a deployment              |
| Renaming or removing a **route**                     | Clients break                                                                                    |
| Renaming an **environment variable**                 | The value falls back to a default nobody chose                                                   |
| Removing a column, or making a nullable one required | An existing row cannot be read, or an existing write cannot be made                              |
| Narrowing a **configuration** schema                 | An application that was valid becomes unstartable                                                |
| Removing or narrowing an **extension point**         | Whatever an application implemented against it stops compiling                                   |

The first five are the ones worth being blunt about: **add keys, never rename one.**
A renamed permission key is a silent authorization change, and it is silent in both
directions.

### Not breaking

| Change                                          | Conditions                                          |
| ----------------------------------------------- | --------------------------------------------------- |
| Adding a permission                             | Nothing grants it automatically, so no role changes |
| Adding an audit action                          | Consumers filter by action                          |
| Adding a route                                  | Nothing referenced it                               |
| Adding an optional configuration field          | It must have a default, so `{}` still parses        |
| Adding a nullable column, or one with a default | Existing rows remain readable                       |
| Adding a feature flag                           | It must default to off if it gates anything risky   |
| Adding an extension point                       | Existing implementations are unaffected             |
| Tightening validation on a **new** field        | Nothing was sending it                              |

Tightening validation on an _existing_ field is a judgement call. Rejecting input
that was previously accepted breaks a caller that was relying on it; if the previously
accepted input was unsafe, break it and say so in the changelog.

## Stability

Each module declares one:

| Stability      | Means                                       | Installer behaviour       |
| -------------- | ------------------------------------------- | ------------------------- |
| `experimental` | The surface may change in a minor version   | Installs normally         |
| `stable`       | The surface changes only as described above | Installs normally         |
| `deprecated`   | Do not build anything new on it             | Refused without `--force` |

`experimental` is not a disclaimer for weak code — every module here has isolation,
RBAC, configuration and lifecycle tests regardless. It states that the _shape_ is
still being learned from real products.

## Changing a module

1. **Add, do not rename.** If a key has to change meaning, add the new one, support
   both, and remove the old one in a later version with a note.
2. **Bump the version in the catalog entry.** The catalog is the single declaration
   point; nothing else needs editing.
3. **Bump the dependency ranges that need it.** If a dependent module was reviewed
   against the old behaviour, its range should not silently accept the new one.
4. **Add a migration for a schema change.** The module ships the fragment; the
   application generates the SQL. A destructive change needs a note in the module's
   README saying what an operator has to do.
5. **Record it.** Each module's README carries a Changes section.

## Upgrading a module in an application

`trustos upgrade` does not exist yet, and this is deliberate: an automated upgrade
that rewrites security-relevant wiring is worse than a documented manual one. Today:

```bash
# 1. Re-run the installer. Managed files are regenerated; yours are untouched.
trustos add-module notification --path ../my-app --framework-path .

# 2. Pick up the new package version and the schema change.
cd ../my-app
npm install
npm run db:migrate

# 3. Read what changed, and check the permission list against your seed.
#    New permissions are not granted to anyone until you grant them.
npm test
```

Step 3 is the one that gets skipped. A module that added a permission has added a
capability nobody can use until a role holds it — which is the correct default, and
also the reason a feature can appear to be broken after an upgrade.

## What the framework does not do

- **No remote resolution.** Modules are local and version-controlled. There is no
  registry lookup, no download, and no plugin marketplace.
- **No post-install scripts.** A module contributes files, dependencies and
  documentation. Nothing a module ships executes during an install.
- **No automatic migration.** The installer copies schema fragments and tells you to
  run `db:migrate`. Generating SQL against an imagined schema is a guess; generating
  it against the real one is correct.
- **No self-update.** The CLI is upgraded like any other dependency.
