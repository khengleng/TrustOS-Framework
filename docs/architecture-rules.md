# Architecture rules

The rules a codebase actually lives by are the ones a machine checks. Everything else is a
document people agree with and then violate, because the violation is invisible until somebody
reads the whole tree — and nobody reads the whole tree.

So these rules are **data**, in `@trustsystem/architecture-validator`, and every violation names a
file, a line and a fix.

```bash
trustos architecture-check              # the whole repository
trustos architecture-check --strict     # warnings block too
trustos architecture-check --json       # for CI
```

---

## 1. Layers

Four layers. The direction is always downward.

| Layer        | Contains                                                                                                               | May depend on                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `foundation` | errors, validation, shared-types, config, logging                                                                      | nothing                          |
| `platform`   | database, auth, rbac, tenancy, audit, observability, authorization, security-policy, security-events, security-testing | foundation                       |
| `capability` | every other package                                                                                                    | foundation, platform             |
| `product`    | apps, templates                                                                                                        | foundation, platform, capability |

**`no-upward-dependency`** is the rule that does the work. A foundation package that imports a
product one cannot be reused without the product — which is the moment a framework stops being
one.

The authorization engine sits in `platform` rather than `capability` because every capability
above it may need to ask "is this allowed". Putting it higher would make the question unaskable
from anything that is not itself a capability.

Fix a violation by inverting the dependency through an extension point, or by moving the shared
piece down a layer. Never by widening `mayDependOn`.

---

## 2. Dependencies

**`declared-dependencies-only`** — a package may only import framework packages it declares in
`package.json`. An undeclared import works in the monorepo and fails when the package is installed
on its own, which is discovered by whoever installs it first.

Tests are exempt: a spec that needs a fixture from another package is not a production dependency,
and forcing it into `package.json` would put test-only packages into every consumer's install.

**`no-cross-package-deep-import`** — import `@trustsystem/x`, never `@trustsystem/x/src/internal`. A deep
import binds to a file layout that is not part of the contract and breaks on a refactor nobody
thought was breaking.

### Generated code is not an import

A package that writes files as template literals contains lines that look exactly like imports.
The validator tracks template-literal state and skips them — otherwise `@trustsystem/code-generator`
appears to depend on everything it can generate for, which is both wrong and unfixable, since not
importing them is the point.

---

## 3. Naming and structure

**`kebab-case-files`** (warning) — source files are kebab-case, with dot-separated role suffixes
allowed: `audit.service.ts`, `scope.guard.ts`. That is the Nest convention and the repository uses
it consistently. Next.js's required names — `page`, `layout`, `route`, `[id]` — are exempt: a
naming rule that fights the framework it generates for is a rule that gets switched off.

**`spec-beside-source`** (warning) — a test lives beside its subject as `<name>.spec.ts`. A
separate test tree drifts out of step with the one it tests.

---

## 4. Security rules

These are `error` and **cannot be lowered to `warning`** — the schema refuses it. An unenforced
security rule is a comment.

| Rule                       | Catches                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `no-secret-in-source`      | Private keys, AWS keys, GitHub tokens, `sk-` keys, credential literals                                                     |
| `no-console-in-packages`   | `console.*` in a framework package — it bypasses redaction, so a value that would have been masked reaches the log in full |
| `no-raw-sql-interpolation` | A template literal inside `$queryRaw`, or any `$queryRawUnsafe`                                                            |
| `no-float-money`           | Floating-point arithmetic on something named like money                                                                    |

### Why tests are exempt from the pattern rules

A spec that verifies a token is rejected has to contain a token-shaped string. One that proves a
query is parameterized has to contain an unparameterized one. The rules fire on every such test,
and a rule whose findings are almost all false is a rule people switch off wholesale — taking the
true findings with it.

The layering and dependency rules still apply to tests, because those have no equivalent "the
fixture is the point" defence.

Scripts whose output _is_ their interface — the CLI, seeds, scaffolders, benchmarks — are exempt
from `no-console-in-packages` for the same reason: routing them through a structured logger would
emit JSON where a human expects text.

---

## 5. Suppression

One line above the violation:

```ts
// architecture-ignore: no-secret-in-source — a development seed password, never used outside seeding
const DEMO_PASSWORD = 'TrustOSDemo2026!';
```

The rule id must be named and the reason must be at least ten characters. There is **no
file-level or repository-level suppression**, deliberately: a rule that can be switched off for a
whole file is a rule that gets switched off for a whole file.

A blanket disable with no reason is how a rule stops meaning anything — the suppression outlives
the person who understood it, and the next reader cannot tell whether it still holds.

---

## 6. Adding a rule

1. Add it to `FRAMEWORK_RULES` in `packages/architecture-validator/src/rules.ts`.
2. Write the check in `validator.ts`. Take files as data; never touch the filesystem.
3. Write the `remediation` first. A rule that only says what is wrong makes every reader work out
   the fix independently.
4. Run it against the whole repository. **A new rule with eighty violations is not a standard —
   it is a standard nobody adopted.** Either fix them in the same change or start the rule as a
   warning with a dated plan to raise it.
5. Add a test for the true positive _and_ for the false positive you are most worried about.

Approval: Platform Team and Security. A relaxed rule is a permanently relaxed rule.

---

## 7. Domain boundaries

Beyond the mechanical rules, three conventions the validator cannot check but review must:

- **A module owns its data.** No module reads another module's tables directly; it goes through
  the owning module's service or an event.
- **Permission keys are namespaced under their module** and are permanent. Add freely, never
  rename — a renamed key silently revokes access on every deployment that has not been migrated.
- **The composition root is human-owned.** Installers add to `TRUSTOS_MODULE_IMPORTS`; nothing
  generated edits `app.module.ts`, because the guard order there _is_ the security model.
