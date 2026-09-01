# Generator security

A code generator writes files, creates directories and — if careless — deletes
them. It is worth being explicit about what it will and will not do, and which
of those guarantees are enforced by code rather than by intention.

---

## 1. Threat model

### What the generator trusts

**Template files.** They live in this repository, are version-controlled, and go
through review. The generator will only ever write content derived from them.
There is no remote fetch, no plugin resolution and no self-update, so "what
could this write?" is answerable by reading `templates/`.

**The invoking user's filesystem permissions.** The generator does not escalate.
It writes as whoever ran it.

### What the generator does not trust

**Every prompt answer and every flag value.** These reach file paths,
`package.json`, and generated TypeScript. They are validated before anything is
computed, and rejected rather than escaped.

**Template file paths.** A malformed or malicious path in a template is the one
thing that could write outside the project, so containment is checked per file,
not once per run.

**The target directory.** It may already contain someone's work.

### Adversaries considered

| Adversary                           | Concern                              | Mitigation                                            |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| A careless user                     | Generating over an existing project  | Non-empty directories refused without `--force`       |
| A mistaken template author          | A path that escapes the project      | Per-file containment check; `validate-template`       |
| A malicious prompt answer           | Injecting code into generated source | Input allow-lists; values never compiled as templates |
| A malicious prompt answer           | Path traversal via the project name  | Name charset validated; result contained              |
| Anyone reading the repository later | A secret committed by the generator  | `.env` and key material refused by construction       |

### Explicitly **not** in the threat model

- **A malicious template.** Templates are trusted code. A reviewer who approves
  a hostile template has already lost; `validate-template` catches mistakes, not
  sabotage.
- **A compromised npm registry.** Generated projects install dependencies;
  supply-chain integrity is a separate concern (lockfiles, `npm audit`).
- **A hostile local filesystem.** Symlink races on the target directory are not
  defended against beyond skipping symlinks in template trees.

---

## 2. File-system safety

### The invariant

**No write ever lands outside the project directory.** Everything else in this
document is a convenience; this is the property that must not have a hole.

It is enforced in `resolveWithin`, which is called for **every file in the
plan** — not once on the root:

```ts
const absolutePath = resolveWithin(projectRoot, targetPath);
```

The check operates on the _resolved_ path rather than pattern-matching the
input, because there is no reliable way to enumerate every string meaning "go
up a level". `a/../../b`, `a/b/../../../c` and `/etc/passwd` all normalize to
something outside the root, and a resolved comparison catches all of them
without needing to recognise any of them.

Rejected outright: absolute paths, drive-qualified paths (`C:foo`), and paths
containing a null byte.

Containment compares path **segments**, not string prefixes — `/tmp/app-evil`
starts with `/tmp/app` as a string but is not inside it.

### Paths are never templated

Template file paths are literal. The only user input that becomes a path is the
project directory name, which is charset-validated, length-limited, checked
against a reserved list, and then contained. **No other prompt answer can
influence where a file is written.**

### Symlinks in template trees are skipped

Following one out of the template tree is exactly the escape the containment
check exists to prevent, and no template legitimately needs one.

---

## 3. Unsafe input handling

Validation happens once, before any filesystem work, so a bad answer fails
before a directory exists.

| Input             | Rule                                                      |
| ----------------- | --------------------------------------------------------- |
| Application name  | `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars, not reserved      |
| Package name      | npm rules; lowercase; no leading `.` or `_`; not reserved |
| Display text      | Non-empty, length-limited, passes the value scan          |
| Port              | Integer 1–65535                                           |
| Roles             | `^[a-z][a-z0-9_]*$` each, at least one                    |
| Deployment target | Must be one the template declares                         |

### Reserved names

`node_modules`, `.git`, `dist`, `src`, `test`, `npm`, `trustos`, and the Windows
device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). The
device names matter because a directory called `CON` cannot be created or
deleted on Windows; `node_modules` matters because it breaks module resolution
for everything above it.

### The value scan

Values land inside TypeScript string literals, JSON and Markdown. Rather than
escaping correctly for every target syntax — a losing game — the following are
rejected:

| Rejected           | Why                                                  |
| ------------------ | ---------------------------------------------------- |
| Backticks          | Would terminate a template literal in generated code |
| `${`               | Template-literal interpolation                       |
| `{{`               | Would be re-read as a template expression            |
| `<script`          | Reaches the admin application's markup               |
| Control characters | Corrupt files and log lines                          |

Ordinary punctuation, apostrophes, ampersands and non-ASCII text are all
accepted: `Wing Bank (Cambodia) Plc.`, `O'Brien & Sons` and `ធនាគារវីង` are
valid product names.

---

## 4. Template injection

**User input is only ever data.** It is passed to the renderer as values and is
never compiled as a template, so there is no path from a prompt answer to
template execution. A value of `{{constructor}}` renders as the literal text
`{{constructor}}`.

Two renderer settings carry weight:

- **`strict: true`** — a reference to an undeclared variable throws instead of
  rendering an empty string. Silently emitting `DATABASE_URL=` or
  `const name = ;` into a generated project is the failure this prevents, and
  `validate-template` relies on it.
- **`noEscape: true`** — the output is source code, not HTML. Escaping would
  turn `&&` into `&amp;&amp;` and corrupt every generated file. Safety comes
  from validating input instead.

Handlebars helpers are limited to pure casing and formatting functions. There is
no helper that reads a file, runs a command, or evaluates a string.

---

## 5. Command injection and post-generation scripts

**The generator runs exactly one external command: `git init`.**

```ts
await execFileAsync('git', ['init', '--quiet'], { cwd: projectRoot });
```

`execFile` with an argument array, never a shell string — the project path comes
from user input, and a shell would interpret anything in it. There is no
`git commit`: what to commit, and under whose name, is the user's decision.

**Templates cannot declare scripts to run.** There is no `postGenerate` hook, no
`scripts` field in `template.json`, and no mechanism for a template to execute
anything at generation time. A template that needs setup documents it in the
generated README.

This is a deliberate omission. Generator ecosystems that allow post-generation
scripts turn "scaffold a project" into "execute arbitrary code from a template",
and the blast radius of a mistaken template becomes the whole machine.

`trustos doctor` also uses `execFile` with argument arrays to probe for `npm`,
`git`, `psql` and `railway`.

---

## 6. Secret handling

**The generator never produces a secret.**

| Guarantee                         | Enforcement                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No `.env` is ever written         | `assertNotSecretFile` refuses any `.env` / `.env.*` except `.env.example`                                         |
| No key material is written        | Refuses `.pem`, `.key`, `.p12`, `.pfx`, `.jks`                                                                    |
| Templates contain no secrets      | `validate-template` scans for private-key blocks, AWS keys, GitHub tokens, Slack tokens and hardcoded JWT secrets |
| Generated projects ignore secrets | The generated `.gitignore` covers `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`                                     |

`.env.example` ships obvious placeholders — `development-only-jwt-secret-change-me-please`
— which `@trustsystem/config` **rejects in production**. A generated application
refuses to start with a placeholder secret, so the failure surfaces at deploy
time rather than as a guessable signing key in production.

The generated README and `docs/deployment.md` both give the command for
generating real secrets, and state that the two JWT secrets must differ.

---

## 7. Overwrite and rollback behaviour

### Nothing is overwritten silently

A non-empty target directory is refused, naming the first conflict and
suggesting `--force`. Without `--force`, an existing file is never touched.

### Generation is transactional

If any write fails, **everything this run created is removed**. Half a generated
project is worse than none: the user cannot tell which files are real, and the
obvious recovery — re-run — hits "directory not empty".

Rollback is the more paranoid path, because a generator that deletes is more
dangerous than one that writes:

- Only paths **this run created** are removed, tracked as they are created.
- Each path is re-checked for containment **before** deletion.
- Directories are removed with `rmdir`, not `rm -r`, so a directory containing
  anything the generator did not create is left alone.
- Deletion failures are collected rather than thrown — a rollback that stops at
  the first error leaves more mess than one that keeps going.

### Dry run

`--dry-run` runs the identical code path and stops before the write. A dry run
cannot succeed where a real run would fail, because both build the same plan
through the same validation.

---

## 8. Determinism

The same inputs produce byte-identical output. This matters for security
review: a reviewer can generate a project, read it, and know that the same
command will produce that exact tree for everyone else.

Achieved by:

- sorting directory listings at every level, so traversal order does not depend
  on the filesystem
- sorting the plan by target path
- normalizing every file to LF with a trailing newline
- **taking the timestamp as an input**, not from the clock — `--generated-at`

That last point is the one that could have been fudged. `trustos.json` records
when a project was generated, which is inherently non-deterministic; making it
an explicit input keeps both properties true instead of quietly dropping one.

---

## 9. Residual risks

These are accepted, not solved. Each would need a decision to address.

1. **Templates are trusted code.** A reviewer who approves a hostile template
   defeats every control here. Mitigation is process: named owners, review, and
   the approval matrix in [`templates.md`](templates.md).

2. **`--framework-path` links to an arbitrary local directory.** It rewrites
   generated dependencies to `file:` paths. Pointing it at a hostile checkout
   would install that code. It exists only because the packages are
   unpublished, and it should disappear when they are.

3. **Generated projects install dependencies from npm.** The generator does not
   run `npm install`, but the user will. Supply-chain integrity is a separate
   concern: lockfiles and `npm audit --audit-level=high` in CI.

4. **Symlink races on the target directory.** Containment is checked at plan
   time and again before each delete, but a sufficiently determined local
   attacker who can swap a directory for a symlink between the check and the
   write is not defended against. This needs `openat`-style APIs Node does not
   expose portably.

5. **`git init` runs an external binary.** The arguments are fixed and the path
   is validated, but a compromised `git` on `PATH` is out of scope.

6. **No integrity check on the templates directory.** `--templates-root` accepts
   any path, and there is no signature over template contents. Someone who can
   write to the templates directory can change what is generated — but they
   could equally change the generator.

7. **The generated admin console stores tokens in `localStorage`.** Inherited
   from the framework, documented in every generated project's `docs/security.md`
   and README. A single XSS in a generated console is account takeover.

---

## 10. Testing the guarantees

Every claim above has tests, because a security property nobody exercises is a
comment:

| Claim                                                           | Tests                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| No write outside the project                                    | `packages/generator-core/src/paths.spec.ts`             |
| Input validation and reserved names                             | `packages/generator-core/src/naming.spec.ts`            |
| No template injection; strict rendering                         | `packages/generator-core/src/render.spec.ts`            |
| Rollback removes only what it created                           | `packages/generator-core/src/writer.spec.ts`            |
| No `.env`, no key material, dry-run writes nothing, determinism | `packages/generator-core/src/generate.spec.ts`          |
| Template contract, including secret scanning                    | `packages/generator-core/src/validate-template.spec.ts` |
| Unsafe names rejected through the CLI                           | `packages/cli/src/program.spec.ts`                      |

Run them with `npm test`. CI additionally generates all five templates and
builds and tests each result, so a guarantee that holds in a unit test but
breaks in a real generated project fails the build.
