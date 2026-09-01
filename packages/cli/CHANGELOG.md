# Changelog — @trustsystem/cli

All notable changes to the TrustOS CLI. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/).

The CLI version, the framework version and each template version move
independently. A generated project records all three in its `trustos.json`.

## [Unreleased]

### Added

- **`trustos add-module <modules…>`** — installs modules into a generated
  application. Local only: every module is already in this repository and has been
  through review, so there is no download, no registry lookup and no post-install
  script.
  - Resolves dependencies (`document` pulls in `file-storage`) and installs them
    dependency-first.
  - Checks compatibility against the framework version recorded in the
    application's `trustos.json`, and refuses a `deprecated` module without
    `--force`.
  - Plan-then-apply, so `--dry-run` runs the identical code path and stops before
    the write.
  - Idempotent: a module already installed is reported and skipped, and the
    managed files are regenerated from the whole installed set rather than
    appended to.
  - Refuses to overwrite a file it does not own. `app.module.ts` is never touched.
  - Rolls a failed run back — files it created are removed, files it overwrote are
    restored.
  - Flags: `--path`, `--framework-path`, `--include-optional`, `--dry-run`,
    `--force`, `--verbose`, `--json`, `-y/--yes`, `--generated-at`.
- **`trustos list-modules`** — with `--verbose` and `--json`. Reads the catalog,
  which is data, so listing a module never imports or executes one.

### Changed

- `add-module` was a placeholder in 0.1.0 and is now implemented. `upgrade`
  remains a placeholder and still exits non-zero.
- Generated applications now ship `apps/api/src/modules/trustos-modules.ts` (empty
  until a module is installed) and `docs/modules.md`, and `trustos.json` gains a
  `modules` array.
- Generated `package.json` now pins the same transitive advisories the framework
  root pins (`postcss`, `sharp`, `js-yaml` via `@nestjs/swagger`), so a generated
  application reports zero high-severity vulnerabilities rather than three.
- Generated applications now declare `pino-pretty` and `rimraf`, which their own
  scripts and logger already required.

### Fixed

- `AppModule` in the base template now exports `PrismaService`. It was provided
  but not exported, so any module or product module injecting it would have failed
  to resolve at start-up — a boot failure that only appears when an application is
  actually booted.

## [0.1.0] — 2026-07-30

First release. Generates TrustOS applications from five approved, local
templates.

### Added

- **`trustos new <template>`** — interactive or fully flag-driven generation.
  Validates every answer before touching the disk, then writes the whole plan
  as a transaction.
  - Flags: `--dry-run`, `--force`, `--verbose`, `--no-git`, `--no-api`,
    `--no-admin`, `--no-auth`, `--yes`, `--target-dir`, `--templates-root`,
    `--framework-path`, `--generated-at`, plus one per prompt.
- **`trustos list-templates`** — with `--verbose` and `--json`.
- **`trustos validate-template [id]`** — ten checks per template, including that
  each ships tenant-isolation tests and contains nothing secret-shaped.
  `--all` and `--json` for CI.
- **`trustos doctor`** — Node, npm, Git, PostgreSQL client, Railway CLI,
  framework compatibility and working-directory permissions. Optional tooling
  warns; it never fails.
- **`trustos add-module`** and **`trustos upgrade`** — registered placeholders
  that explain what they will do, say what to do instead today, and exit
  non-zero so a script cannot mistake them for success.

### Templates

| Template            | Entities                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `generic-saas`      | WorkspaceItem                                                           |
| `merchant`          | Merchant, Store, Branch, MerchantMember                                 |
| `learning`          | StudentProfile, LearningSession, QuizAttempt                            |
| `payment-gateway`   | MerchantAccount, ApiKey, Payment, PaymentStatusHistory, WebhookEndpoint |
| `telegram-mini-app` | Task, TelegramProfile                                                   |

Every generated application includes a NestJS API, a Next.js admin console
(except the Mini App, which ships a Mini App frontend instead), PostgreSQL with
Prisma, framework authentication, organization tenancy, RBAC, audit logging,
health and readiness endpoints, tenant-isolation tests, `AGENTS.md`,
`trustos.json`, and Railway configuration.

### Security properties

- No write ever lands outside the project directory; containment is checked per
  file, not once per run.
- `.env` and key material are refused by construction — templates ship
  `.env.example` only.
- User input is only ever data, never compiled as a template.
- Exactly one external command is run (`git init`), via `execFile` with an
  argument array. Templates cannot declare scripts.
- A failed run removes everything it created, using `rmdir` so a directory it
  did not create is left alone.
- The same inputs produce byte-identical output; the generation timestamp is an
  explicit input rather than ambient state.

Detail in [`docs/generator-security.md`](../../docs/generator-security.md).

### Known limitations

1. **The framework packages are unpublished.** A generated application needs
   `--framework-path` to resolve `@trustsystem/*` as `file:` links. This disappears
   when the packages are published.
2. **`add-module` and `upgrade` are not implemented.** Framework migrations are
   deliberately out of scope for this phase.
3. **The framework Prisma schema is copied, not imported.** Each generated
   project owns `prisma/schema/00-framework.prisma` and it must be refreshed by
   hand when the framework schema changes.
4. **No remote templates.** Templates are local and version-controlled by
   design: no fetch, no plugin resolution, no marketplace, no self-update.
5. **Interactive prompts are not covered by automated tests.** The
   non-interactive path — the same validators, the same generation — is.

---

## Releasing

Not automated, and not published from CI. A release is a deliberate act.

```bash
# 1. Everything must be green.
npm run lint && npm run typecheck && npm test && npm run build
npm run db:validate
node packages/cli/bin/trustos.js validate-template --all
npm audit --audit-level=high

# 2. Generate and verify at least one application end to end.
node packages/cli/bin/trustos.js new generic-saas --yes \
  --target-dir /tmp/release-check --framework-path "$PWD" --no-git
cd /tmp/release-check/generic-saas
npm install && npm run db:validate && npm run typecheck && npm test && npm run build
cd -

# 3. Decide the version.
#    patch — a fix that changes no generated output
#    minor — a new command, a new flag, a new template, additive output
#    major — a renamed or removed command or flag; restructured output
npm version <patch|minor|major> -w @trustsystem/cli --no-git-tag-version

# 4. Keep the version literal in step with package.json.
#    packages/cli/src/version.ts is asserted against package.json by a test.

# 5. Record the change above, under a new heading with today's date.

# 6. Commit, tag, and open a pull request.
git commit -am "release @trustsystem/cli v<version>"
git tag "cli-v<version>"

# 7. Publish only after review.
npm publish -w @trustsystem/cli --access restricted
```

`packages/cli/src/version.ts` holds the version as a literal rather than
reading `package.json`, so the compiled output does not depend on that file
being at a particular relative depth — which differs between a source checkout,
`dist/`, and a global install. A test asserts the two agree; step 4 is what
keeps it passing.
