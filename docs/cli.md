# TrustOS CLI

`trustos` generates production-ready TrustOS applications from the approved
templates in this repository. A new product goes from nothing to a working,
tenant-isolated, audited, deployable application in a few minutes.

The CLI generates code; it does not reimplement any of it. Authentication,
RBAC, tenancy, audit, logging, validation and observability come from the
framework packages, and a generated application depends on them rather than
carrying its own copies.

---

## Installation

### From this repository (current)

The framework packages are not published to npm yet, so the CLI runs from a
checkout:

```bash
git clone <this-repository> trustos-framework
cd trustos-framework
npm install
npm run build:packages

# Then either invoke it directly:
node packages/cli/bin/trustos.js --help

# …or link it onto your PATH:
npm link -w @trustos/cli
trustos --help
```

Because the packages are unpublished, a generated application needs to be told
where the framework lives:

```bash
trustos new merchant --framework-path /path/to/trustos-framework
```

That rewrites the `@trustos/*` dependencies to `file:` links so the generated
project installs and builds immediately. Without it, `npm install` in the
generated project fails to resolve `@trustos/config`.

### From npm (once published)

```bash
npm install -g @trustos/cli
trustos new merchant
```

At that point `--framework-path` becomes unnecessary: the generated
`package.json` will reference published versions.

**Requires** Node 20.11+ and npm 10+. Run `trustos doctor` to check.

---

## Commands

| Command                          | Status              | What it does                                                         |
| -------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `trustos new <template>`         | implemented         | Create a new application                                             |
| `trustos list-templates`         | implemented         | List the approved templates                                          |
| `trustos validate-template [id]` | implemented         | Check a template against the generator contract                      |
| `trustos doctor`                 | implemented         | Check this machine can generate and run TrustOS applications         |
| `trustos list-modules`           | implemented         | List the modules that can be installed                               |
| `trustos add-module <modules…>`  | implemented         | Install modules into a generated application                         |
| `trustos upgrade`                | **not implemented** | Will migrate an application to a newer framework or template version |
| `trustos --help` / `--version`   | implemented         |                                                                      |

`upgrade` is registered on purpose: it appears in `--help`, explains what it will
do, says what to do instead today, and exits non-zero so a script cannot mistake
"not implemented" for success.

---

## `trustos new`

### Interactive

```bash
trustos new merchant
```

Prompts for, and validates, each of:

| Prompt                        | Default                  | Validation                          |
| ----------------------------- | ------------------------ | ----------------------------------- |
| Application name (directory)  | the template id          | lowercase, hyphenated, not reserved |
| npm package name              | the application name     | npm naming rules; scope allowed     |
| Organization name             | `TrustOS`                | non-empty, no injection characters  |
| Product display name          | derived from the name    | non-empty                           |
| Description                   | the template description | non-empty, ≤ 400 characters         |
| Include the API               | yes                      |                                     |
| Include the admin application | yes                      |                                     |
| Enable authentication         | yes                      |                                     |
| Initial roles                 | the four framework roles | lowercase snake_case                |
| Deployment target             | the template's first     | must be supported by the template   |
| API port                      | `3000`                   | 1–65535                             |
| Initialize git                | yes                      |                                     |

The database is PostgreSQL. It is stated rather than asked, because a question
with one possible answer only wastes the reader's time.

### Non-interactive

Use `--yes` to accept every default, or supply flags. The CLI also stops
prompting automatically when stdin is not a TTY, so it cannot hang in CI.

```bash
trustos new merchant \
  --yes \
  --name wing-merchant \
  --package-name @wing/merchant \
  --organization "Wing Bank" \
  --display-name "Wing Merchant" \
  --description "Merchant onboarding and store management." \
  --port 3100 \
  --deploy railway \
  --roles organization_owner,administrator,store_manager,auditor \
  --framework-path /path/to/trustos-framework
```

### Flags

| Flag                                    | Effect                                                |
| --------------------------------------- | ----------------------------------------------------- |
| `--dry-run`                             | Print what would be written; write nothing            |
| `--force`                               | Overwrite existing files                              |
| `--verbose`                             | List every file, not just the first fifteen           |
| `--no-git`                              | Skip `git init`                                       |
| `--no-api` / `--no-admin` / `--no-auth` | Omit that part                                        |
| `-y, --yes`                             | Never prompt                                          |
| `--target-dir <path>`                   | Where to create the project directory                 |
| `--templates-root <path>`               | Use a different templates directory                   |
| `--framework-path <path>`               | Link `@trustos/*` to a local framework checkout       |
| `--generated-at <iso>`                  | Fix the generation timestamp, for reproducible output |

`--dry-run` runs the identical code path as a real run and stops before the
write, so a dry run cannot succeed where a real one would fail.

### What you get

```
<name>/
├── apps/
│   ├── api/                  NestJS API — product endpoints, auth, audit reads
│   └── admin/                Next.js console — login, org picker, resources, audit
├── packages/
│   ├── product-domain/       product permissions and domain types
│   └── shared-types/         types shared by the API and the admin app
├── prisma/
│   ├── schema/
│   │   ├── 00-framework.prisma   framework models (copied; do not edit)
│   │   └── 10-product.prisma     product models
│   └── seed.ts               permissions, roles, and dev-only demo data
├── docs/                     architecture.md, deployment.md, security.md
├── AGENTS.md                 rules for AI coding agents
├── trustos.json              framework/template/CLI versions, generation time
├── railway.toml              when the target is Railway
├── .env.example              never .env
└── README.md
```

Then:

```bash
cd <name>
cp .env.example .env      # fill in DATABASE_URL
npm install
npm run db:migrate && npm run db:seed
npm run dev
```

---

## `trustos list-templates`

```bash
trustos list-templates            # ids, names, descriptions
trustos list-templates --verbose  # apps, entities, owner, exclusions, minimum framework
trustos list-templates --json     # machine-readable
```

| Template            | Entities                                                                | Apps         |
| ------------------- | ----------------------------------------------------------------------- | ------------ |
| `generic-saas`      | WorkspaceItem                                                           | api, admin   |
| `merchant`          | Merchant, Store, Branch, MerchantMember                                 | api, admin   |
| `learning`          | StudentProfile, LearningSession, QuizAttempt                            | api, admin   |
| `payment-gateway`   | MerchantAccount, ApiKey, Payment, PaymentStatusHistory, WebhookEndpoint | api, admin   |
| `telegram-mini-app` | Task (plus TelegramProfile)                                             | api, miniapp |

---

## `trustos validate-template`

```bash
trustos validate-template merchant
trustos validate-template --all      # CI uses this
trustos validate-template --all --json
```

Ten checks per template, exiting non-zero if any fails:

| Check                      | Fails when                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| registry metadata          | `template.json` is invalid, or its id disagrees with the registry                                                   |
| required files             | `package.json`, `README.md`, `AGENTS.md`, `trustos.json`, `.gitignore`, `.env.example` or a `docs/` file is missing |
| safe paths                 | any template path is absolute, drive-qualified or contains `..`                                                     |
| build configuration        | `package.json` or `tsconfig.base.json` is missing                                                                   |
| health endpoint            | the API has no composition root, so no `/health` and `/ready`                                                       |
| test configuration         | no `vitest.config.ts`, no specs, or **no tenant-isolation spec**                                                    |
| deployment configuration   | the template claims Railway support but ships no `railway.toml`                                                     |
| no unresolved placeholders | a template references a variable the manifest does not declare                                                      |
| no committed secrets       | a private key, cloud token or hardcoded JWT secret is present                                                       |
| valid package references   | the template imports a `@trustos/*` package it did not declare                                                      |

Warnings are reported but do not fail the command.

---

## `trustos list-modules`

```bash
trustos list-modules
trustos list-modules --verbose      # permissions, routes, configuration, extension points
trustos list-modules --json
```

Reads the module catalog, which is data — so listing modules never imports or
executes one. The verbose form is what to read before deciding what to install: it
prints each module's permissions, routes, environment variables, feature flags,
extension points and, deliberately, what it does _not_ do.

The last line is the install order when adding all of them, because an install order
is not the order the ids were typed in.

---

## `trustos add-module`

```bash
# Install one module into an application:
trustos add-module notification --path ../my-app --framework-path .

# Dependencies come with it. `document` needs `file-storage`:
trustos add-module document --path ../my-app --framework-path .

# Several at once, resolved into one dependency-first order:
trustos add-module workflow reporting search --path ../my-app --framework-path .

# See what would change and write nothing:
trustos add-module notification --path ../my-app --framework-path . --dry-run --verbose
```

### Flags

| Flag                   | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `--path <dir>`         | Application directory. Defaults to the nearest `trustos.json` |
| `--framework-path <d>` | Framework checkout to install from                            |
| `--include-optional`   | Install optional dependencies too                             |
| `--dry-run`            | Compute and report; write nothing                             |
| `--force`              | Allow a module marked `deprecated`                            |
| `--verbose`            | List every file                                               |
| `--json`               | Machine-readable plan                                         |
| `-y, --yes`            | Do not ask for confirmation                                   |
| `--generated-at <iso>` | Fix the install timestamp, for reproducible output            |

### What it writes

| File                                      | Ownership                                           |
| ----------------------------------------- | --------------------------------------------------- |
| `prisma/schema/NN-<module>.prisma`        | The module's. Refreshed on reinstall                |
| `apps/api/src/modules/trustos-modules.ts` | The installer's. Regenerated from the installed set |
| `apps/api/src/modules/module-config.ts`   | Yours. Created once, never rewritten                |
| `docs/modules.md`                         | The installer's. Regenerated                        |
| `package.json`                            | Merged: dependencies only                           |
| `trustos.json`                            | Merged: the `modules` array; unknown keys preserved |
| `.env.example`                            | Merged: one anchored block per module, names only   |

Everything the installer owns carries a marker comment. A file that exists, is not one
of the merge targets, and has no marker is treated as code somebody wrote: the run
stops and names it. `app.module.ts` is never touched.

A failed run is rolled back — files it created are removed, files it overwrote are
restored — so a partial install is not a state you can end up in.

### It is idempotent

A module already installed is reported and skipped. The managed files are regenerated
from the whole installed set rather than appended to, so nothing accumulates.

### After installing

```bash
npm install
npm run db:migrate     # generates the SQL for the new fragments
npm test
```

Then seed the permissions. Nothing grants them — see `docs/modules.md`.

---

## `trustos doctor`

```bash
trustos doctor
trustos doctor --json
```

```
PASS Node.js               v20.19.1
PASS npm                   v10.8.2
PASS Git                   git version 2.43.0
WARN PostgreSQL client     psql not found (optional)
     Only needed to inspect a database locally; generation does not use it.
WARN Railway CLI           not found (optional)
     npm i -g @railway/cli — only needed to deploy.
PASS Framework packages    TrustOS framework v0.1.0 at /path/to/templates
PASS Working directory     /current/dir is writable
```

A missing **optional** tool is a `WARN` and never a `FAIL`. A diagnostic that
exits non-zero because someone has no Railway CLI trains people to ignore it,
and then it stops catching the real problems. Every non-passing check carries a
remedy.

Exit status is `0` unless something `FAIL`ed.

---

## Troubleshooting

| Symptom                                                              | Cause and fix                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Could not locate the templates directory`                           | Running outside a framework checkout. Pass `--templates-root`, or run from the repository.                                         |
| `npm error could not resolve @trustos/config` in a generated project | The packages are unpublished. Regenerate with `--framework-path /path/to/trustos-framework`, or add the links by hand.             |
| `Cannot find module '@prisma/client'` in a generated project         | `postinstall` did not run. Use `npm install`, not `npm install --ignore-scripts`.                                                  |
| `Directory … already exists and is not empty`                        | Choose another name, remove the directory, or pass `--force`.                                                                      |
| `Invalid application name`                                           | Lowercase letters, digits and single hyphens only, e.g. `merchant-portal`.                                                         |
| `Template … failed to render: "x" not defined`                       | A template references an undeclared variable. Add it to the manifest's `requiredVariables`, then `trustos validate-template <id>`. |
| `needs framework 0.2.0 or newer`                                     | The template is newer than this checkout. Pull the framework.                                                                      |
| Generation created the project in the wrong place                    | `--target-dir` sets the parent directory; the project is created inside it.                                                        |
| The CLI hangs with no prompt                                         | stdin is not a TTY and `--yes` was not passed. Add `--yes`.                                                                        |
| `Generation failed and was rolled back`                              | Something could not be written — usually a permissions problem. Nothing was left behind; fix the cause and re-run.                 |

### Reproducing a generated project exactly

```bash
trustos new merchant --yes --name m1 --generated-at 2026-01-01T00:00:00.000Z
```

Given the same inputs — including `--generated-at` — output is byte-identical.
The timestamp is an input rather than ambient state precisely so that
determinism and a real `generatedAt` in `trustos.json` can both hold.

---

## Related documentation

- [docs/modules.md](modules.md) — the module system, and what `add-module` writes
- [docs/module-versioning.md](module-versioning.md) — compatibility rules

- [`docs/templates.md`](templates.md) — template design rules, ownership, versioning, approval
- [`docs/generator-security.md`](generator-security.md) — threat model and file-system safety
- [`docs/architecture.md`](architecture.md) — the framework the generated code sits on
- `AGENTS.md` inside any generated project — the rules an AI agent must follow there
