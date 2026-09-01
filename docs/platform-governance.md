# Platform governance

How TrustOS is operated and evolved. This is the document that has to stay true for years, so it
states decisions and the reasoning behind them rather than procedures that will be reorganised.

| Page                                           | For                              |
| ---------------------------------------------- | -------------------------------- |
| [developer-guide.md](developer-guide.md)       | Building on the platform         |
| [release-process.md](release-process.md)       | Cutting and supporting a release |
| [upgrade-guide.md](upgrade-guide.md)           | Moving a deployment forward      |
| [architecture-rules.md](architecture-rules.md) | The rules a change must hold     |
| [plugin-development.md](plugin-development.md) | Extending it from outside        |

---

## 1. The governing decisions

Six choices shape everything in Phase 10. Each is a trade, and each is stated with what it costs.

### Offline by default

Nothing in the platform fetches. The module catalogue is local and version-controlled, the
marketplace has no remote, the installer is handed the artefacts it may use, signature
verification uses a local trust store, and telemetry has no default destination.

**What it buys.** No dependency confusion, no typosquatting, no compromised mirror, no
install-time network. An air-gapped install is the _same operation_ as a connected one rather
than a degraded mode nobody tests. Whoever controls the network at install time does not control
what gets installed.

**What it costs.** Publishing a module means shipping a framework release. There is no ecosystem
of third-party modules discoverable from a command. That is a real limitation, and it is the
correct trade for a framework whose deployments include regulated ones.

### Untested is a third answer

The compatibility matrix records what was _verified_. An unrecorded pairing is `unknown`, never
`compatible`.

A rule — "any framework at or above the minimum works" — is right until the framework removes
something, and then it is silently wrong for every module ever published. `unknown` is a useful
answer; a confident wrong one is not. Callers decide what to do with it: the CLI warns, CI can
fail, an interactive upgrade asks.

### Plan, then apply

Every operation that changes something produces an inspectable plan first: installs, upgrades,
migrations, code generation. `--dry-run` is _not calling apply_, never a second code path.

A tool with one path for "what would happen" and another for "what happened" stops predicting the
real run the first time they diverge, and nobody notices until the prediction was the thing being
trusted.

### The framework decides; the deployment does

The platform ships the decision-making — the checks, the refusals, the plans — and stops short of
the irreversible act. It does not execute migrations, take backups, publish releases, install
plugins into a running process, or send telemetry. Those are ports a deployment supplies.

This is why `trustos upgrade` produces a plan rather than performing one, and why
`@trustsystem/upgrade-manager` takes an `UpgradeExecutor`. The actions where a mistake is expensive
are the actions that belong in a deployment's own change control.

### Security is never a licensed feature

Audit, tenant isolation, encryption, RBAC and the guard chain are not entitlements and never will
be. `GATED_FEATURES` contains five operations capabilities and nothing a deployment needs to be
safe.

A framework that puts authentication behind a paid tier produces deployments that turn it off, and
the people harmed are the ones who never saw the invoice.

### Dates, not intentions

Support windows, waiver expiries, key expiries and deprecation removals are all data with a date
on them. "We support the last two majors" is a sentence; `securitySupportUntil` is something
`trustos upgrade` can read.

Dates only ever move later. Shortening support after publication strands the deployments that
planned against it.

---

## 2. Architecture

```
                        ┌─────────────────────┐
                        │  platform-manager   │  one view: version, modules,
                        │                     │  health, licence, upgrade
                        └──────────┬──────────┘
        ┌──────────────┬───────────┼────────────┬──────────────┐
        ▼              ▼           ▼            ▼              ▼
┌───────────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐
│ compatibility │ │dependency│ │framework│ │ license  │ │  telemetry   │
│    engine     │ │ analyzer │ │ health  │ │ manager  │ │  analytics   │
└───────┬───────┘ └────┬─────┘ └────┬────┘ └──────────┘ └──────────────┘
        └──────────────┴────────────┘
                       ▼
              ┌─────────────────┐
              │ version-manager │  semver · ranges · matrix · history
              └─────────────────┘

  supply chain                    lifecycle                    quality
┌──────────────────┐      ┌──────────────────────┐    ┌────────────────────┐
│ module-marketplace│─────▶│   upgrade-manager    │    │   quality-gates    │
│ package-manager   │      │   migration-tools    │    │ architecture-      │
│ plugin-framework  │      │   release-manager    │    │   validator        │
└──────────────────┘      └──────────────────────┘    └────────────────────┘

  generation
┌────────────────────────────────────────────────────┐
│ code-generator · documentation-center · developer-  │
│ portal                                              │
└────────────────────────────────────────────────────┘
```

Every arrow points downward. `version-manager` depends on nothing but `@trustsystem/errors`, and
`platform-manager` depends on almost everything — which is the correct shape for an aggregator
that decides nothing.

---

## 3. Ownership

| Area                        | Owner                    | Accountable for                                    |
| --------------------------- | ------------------------ | -------------------------------------------------- |
| Framework core (Phases 1–4) | Platform Team            | The guard chain, tenant isolation, the audit trail |
| Modules                     | Named per module         | Its catalog entry, its migrations, its support     |
| Templates                   | Named per template       | Its manifest, its `outOfScope`, its regeneration   |
| Releases                    | Release Manager          | Channels, support dates, release notes             |
| Supply chain                | Security                 | The trust store, signing keys, revocation          |
| Architecture rules          | Platform Team + Security | `FRAMEWORK_RULES`, `FRAMEWORK_LAYERS`              |
| Licensing                   | Commercial               | `GATED_FEATURES` — and never adding a security one |

An unowned thing rots: nobody upgrades it, nobody notices when its assumptions age, and the next
product to depend on it inherits the problem.

---

## 4. Change control

| Change                                           | Approval                       | Why                                                                 |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------- |
| Fix inside a module or template                  | Its owner                      | Contained                                                           |
| Add a module, template or plugin extension point | Platform Team                  | It becomes a contract                                               |
| Change `templates/_base`                         | Platform Team                  | Lands in every project generated afterwards                         |
| Change the guard set or its order                | Platform Team **and** Security | It is the security model                                            |
| Change `FRAMEWORK_LAYERS`                        | Platform Team                  | Redefines what "upward" means                                       |
| Add or relax an architecture rule                | Platform Team + Security       | A relaxed rule is a permanently relaxed rule                        |
| Add to `GATED_FEATURES`                          | Commercial + Platform Team     | The list must stay free of security capabilities                    |
| Add a key to the trust store                     | Security                       | A key added because an install asked for it is not a trust decision |
| Shorten a support window                         | **Refused**                    | Deployments planned against the date                                |
| Waive a security, architecture or testing gate   | **Refused**                    | See below                                                           |

### Why three gates cannot be waived

Architecture, security and testing are unwaivable in code, not by policy —
`waiverSchema` refuses a waiver naming them.

The argument: the first time a security gate fires under deadline pressure, a waiver is used. The
second time, the precedent exists. By the fourth, the gate is a formality with a form attached. A
control that can be bypassed under pressure is a control that is absent exactly when it matters.

Everything else may be waived, with a **reason, an owner and an expiry**. A waiver with no expiry
is a permanent exemption written in the language of a temporary one; when the date passes the gate
fails again and the problem is back rather than forgotten.

---

## 5. The framework lifecycle

```
   development ──▶ beta ──▶ rc ──▶ stable ──▶ lts
                                     │          │
                                     ▼          ▼
                                 deprecated  maintenance
                                     │          │
                                     ▼          ▼
                              security-only ──▶ eol
```

Channels move forward only. A stable release that returns to beta is one nobody can trust — the
point of the channel is that it stops changing.

| State           | Means                                           |
| --------------- | ----------------------------------------------- |
| `active`        | Features, fixes and security fixes              |
| `maintenance`   | Fixes and security fixes. LTS lives here        |
| `security-only` | Security fixes only                             |
| `deprecated`    | Superseded; still supported                     |
| `eol`           | Nothing. Upgrading is the only supported action |

An unregistered version is treated as unsupported: nobody has committed to fixing it.

---

## 6. Supply chain

Four properties, in the order an attacker meets them:

1. **The catalogue is local.** There is nothing to typosquat and no mirror to compromise.
2. **A digest proves the bytes did not change.** Checked on every install, including a reinstall
   of something already present — which is exactly when nobody looks.
3. **A signature proves who produced them.** Integrity without authenticity is a checksum against
   disk corruption: an attacker who can modify the artefact can modify the hash beside it.
4. **A missing signature is a failure, never a skip.** `--allow-unsigned` permits exactly one
   failure code and is recorded on the installed record. It never permits a bad signature, an
   unknown key or a revoked one — those are not "unsigned", they are "signed by someone you do
   not trust".

The framework ships **verification, not signatures**. `trustos marketplace` reports every module
as unsigned, honestly, because a deployment signs what it publishes.

### Threats and what stops them

| Threat                    | Control                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Malicious plugin          | Declared permissions, consent at install, review. **Not a sandbox** — see [plugin-development.md](plugin-development.md) |
| Unsigned module           | Refused unless explicitly overridden, and the override is recorded                                                       |
| Dependency tampering      | Lockfile digest, verified on every install                                                                               |
| Supply-chain substitution | Local catalogue; no fetch                                                                                                |
| Version spoofing          | Signature covers the digest; the key decides the algorithm                                                               |
| Unauthorized installation | Consent is required for the four dangerous permissions; policy outranks consent                                          |
| Unsafe code generation    | Generated code is always tenant-scoped, audited and permission-guarded; there is no flag to disable any of it            |
| Licence abuse             | Offline validation; expiry degrades rather than shuts down                                                               |

---

## 7. Telemetry and privacy

Three properties, enforced by the code:

- **Off unless switched on.** `enabled` has no default, so turning it on is visible in a diff.
- **Local-first with no default destination.** The framework ships no exporter and has no
  endpoint. A framework with a hardcoded telemetry URL phones home whatever its documentation
  says.
- **Tenant data cannot be recorded, structurally.** An event carries a name, bounded
  low-cardinality dimensions and numbers. There is no free-text field. `assertNoIdentifiers`
  additionally refuses values shaped like ids, emails or phone numbers — because the interesting
  failure is not malice but somebody adding an order id to make a dashboard more useful.

Counting distinct organizations uses a per-installation salted hash that never leaves the
installation. Without a salt, `hashIdentifier` returns null rather than emitting a reversible
hash of a known identifier space.

`trustos telemetry review` (via `describeExport`) shows exactly what an export would contain.
Nobody should have to read source to find out what a framework would transmit.

---

## 8. Known limitations

Stated plainly, because a governance document that only lists strengths is marketing.

- **Plugins are not sandboxed.** Node has no usable in-process sandbox. The model is signature,
  declared permissions, review, and a host that can refuse.
- **There is no ecosystem.** The offline-by-default choice means third-party modules are not
  discoverable or installable from a command.
- **Compatibility is only as good as the matrix.** An empty matrix makes every pairing `unknown`,
  which is honest but not useful. Populating it is ongoing work.
- **The framework signs nothing.** Signing infrastructure is a deployment's responsibility.
- **`trustos upgrade` plans; it does not execute.** Deliberate, and it means a deployment must
  wire an executor before an upgrade is one command.
- **Four `compareSemver` implementations exist.** `version-manager` is the complete one; the
  others stay until a major version lets the dependency direction change without growing the
  CLI's install size.
