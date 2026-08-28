# Developer guide

Building on TrustOS: what exists, how to use it, and the rules a change has to hold.

| Page                                                    | For                                      |
| ------------------------------------------------------- | ---------------------------------------- |
| [platform-governance.md](platform-governance.md)        | How the platform is operated and evolved |
| [architecture-rules.md](architecture-rules.md)          | The rules, and how to add one            |
| [upgrade-guide.md](upgrade-guide.md)                    | Moving a deployment forward              |
| [templates.md](templates.md) · [modules.md](modules.md) | Starting points and capabilities         |

---

## 1. Starting

```bash
trustos templates                        # 30 templates, by category
trustos new crm --name my-app            # generate
cd my-app && npm install
trustos marketplace                      # what can be added
trustos install search                   # add a capability
trustos platform info                    # what you have
```

Everything is offline. The template library and the module catalogue are local and
version-controlled; nothing fetches.

---

## 2. What is already solved

The most expensive mistake on this platform is rebuilding something that exists. A hand-written
permission check is a second, worse one that will disagree with the first.

| You need                 | Use                        | Never                                  |
| ------------------------ | -------------------------- | -------------------------------------- |
| Authentication, sessions | `@trustos/auth`            | A custom token format                  |
| Permissions              | `@trustos/rbac`            | An `if (user.role === …)`              |
| Tenant isolation         | `@trustos/tenancy`         | A `where` clause you remember to add   |
| An audit trail           | `@trustos/audit`           | A log line                             |
| Money                    | `@trustos/financial-core`  | A `number`                             |
| Approvals                | `@trustos/workflow-*`      | A status column                        |
| Screens, forms, filters  | `@trustos/template-sdk`    | A second description of the same table |
| Versions, ranges         | `@trustos/version-manager` | String comparison                      |

---

## 3. Adding a feature

### Generate the slice

```bash
trustos generate crud --spec invoice.json --dry-run
```

One declaration produces the Prisma model, types, repository, service, controller, isolation test
and documentation. Everything is tenant-scoped, every write is audited and every route carries a
permission — with **no flag to disable any of it**. A generator that could emit an unscoped
repository would eventually emit one, and the endpoint returns every tenant's rows while passing
every test written against a single-tenant fixture.

`--dry-run` prints the files. Generation writes nothing until you drop the flag.

### Then edit it

Generated code is deliberately plain: no base class to inherit, no runtime to understand first. It
is read far more often than it is generated, and the first thing anybody does is change it.

---

## 4. The rules a change has to hold

Checked mechanically by `trustos architecture-check` and `trustos validate`.

1. **Reuse the framework.** See the table above.
2. **Every product model carries `organizationId`.** A model without it cannot be scoped, so every
   query over it returns every tenant's rows — and nothing fails.
3. **No float and no bare `Int` for money.** `Decimal @db.Decimal(28, 8)`, or an integer
   minor-unit column with a `///` comment saying so.
4. **Every write is audited.** A change with no audit row is a change nobody can answer questions
   about six months later.
5. **Every route declares a permission.** The guard denies a route that declares none.
6. **Permission keys are permanent.** Add freely, never rename.
7. **Dependencies point downward.** See [architecture-rules.md](architecture-rules.md).
8. **Declare what you import.** An undeclared import works in the monorepo and fails when the
   package is installed alone.

---

## 5. Quality gates

```bash
trustos validate --results ci-results.json
```

Eleven gates. Three of them — **architecture, security and testing — cannot be waived**, in code
rather than by policy. The first time a security gate fires under deadline pressure a waiver is
used; by the fourth it is a formality with a form attached.

Everything else may be waived with a reason, an owner and an **expiry**. When the date passes the
gate fails again — a waiver buys time rather than granting an exemption.

Performance never blocks. A number from a shared CI machine teaches people to re-run until it
passes, which destroys the signal and the habit together.

No gate runs a tool; each takes the _result_ of one, so a gate behaves identically in CI, on a
laptop and in a pre-commit hook.

---

## 6. Documentation

```bash
trustos docs             # what would be written
trustos docs --write     # write it
```

The rule: **anything derivable from the code is generated, anything not derivable is
hand-written.** Mixing them produces documentation that is partially stale, and a reader who finds
one stale section stops trusting the accurate ones.

Generated: module pages, permission tables, the CLI reference, the API reference, the dependency
graph, the changelog. Hand-written: why a thing is designed the way it is — a generator cannot
produce a reason.

---

## 7. Knowing where you stand

```bash
trustos platform info --verbose   # version, modules, health, licence, compatibility, upgrade
trustos doctor                    # the machine
trustos doctor template           # still matches the template it came from
trustos architecture-check        # the rules
```

`platform info` works **offline with nothing running**, which matters because the moment you most
need it is when you are deciding whether to start the system, or during an incident when it will
not start.

Read `unknown` in a compatibility report as what it says: nobody has verified that pairing. It is
not "broken" and it is not "fine".

---

## 8. Telemetry

Off unless you switch it on, local unless you wire an exporter, and structurally incapable of
carrying tenant data — an event has a name, bounded low-cardinality dimensions and numbers, with
no free-text field.

`describeExport` shows exactly what an export would contain. Nobody should have to read source to
find out what a framework would transmit.

---

## 9. Before you say it is done

```bash
npm run lint
npm run format:check
npm run build:packages
npm test
trustos architecture-check
```

All of them. **Never claim something works because it compiles.** If a test fails, say which one
and what the output was.
