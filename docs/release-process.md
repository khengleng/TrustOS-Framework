# Release process

How a version is cut, supported and retired.

The reason this is written down: **support dates become data rather than intentions.** "We support
the last two majors" is a sentence nobody can act on; a per-release `securitySupportUntil` is
something `trustos upgrade` reads and raises urgency from.

---

## 1. Channels

```
development ──▶ beta ──▶ rc ──▶ stable ──▶ lts
```

Forward only. `ReleaseManager.promote` refuses to move a release backwards — a stable release that
returns to beta is one nobody can trust, and the point of the channel is that it stops changing.

| Channel       | Version must                                    | Who runs it           |
| ------------- | ----------------------------------------------- | --------------------- |
| `development` | anything                                        | The team building it  |
| `beta`        | carry a prerelease identifier                   | Volunteers            |
| `rc`          | carry a prerelease identifier                   | Staging               |
| `stable`      | **not** carry one                               | Production            |
| `lts`         | **not** carry one, and state a support end date | Production, for years |

A "beta" whose version is `1.0.0` installs by default under a caret range, because nothing in the
version says it is a beta. The channel is metadata; the version is what package managers read. The
schema refuses it.

An LTS with no `securitySupportUntil` is refused too: "long term" with no date is a promise nobody
can plan against.

---

## 2. Versioning

Semantic, and describing the **generated output and the public API**.

| Change                                                                             | Bump      |
| ---------------------------------------------------------------------------------- | --------- |
| Fix, comment, test                                                                 | patch     |
| Add a package, module, template, endpoint, permission or CLI command               | minor     |
| Rename or remove any of those; change a guard order; change a schema destructively | **major** |

**Below 1.0.0 the minor is the breaking position.** `0.2.0` may break `0.1.0`. Treating `0.x` as
"anything goes" is how a framework at 0.9 breaks every application on a patch release and calls
itself compliant. `isBreakingChange` encodes this.

---

## 3. Cutting a release

```bash
# 1. Everything green
npm run lint && npm run format:check && npm run build:packages && npm test
trustos architecture-check
trustos validate --results ci-results.json

# 2. What changed
#    Add a VersionEntry to the history: summary, breakingChanges, securityFixes,
#    features, fixes, deprecations. Breaking changes first — a reader deciding whether
#    to upgrade needs to know what will break before what they gain.

# 3. Register it
#    A Release with version, channel, releasedAt and — for stable and lts — the support dates.

# 4. Notes and docs
trustos docs --write
```

Release notes are **generated from the history**, never written twice. A changelog maintained
beside the history disagrees with it within two releases, and the one people read is whichever is
on the website.

---

## 4. Support windows

| Channel  | Active               | Security fixes                          |
| -------- | -------------------- | --------------------------------------- |
| `stable` | until the next minor | until the next major, at least 6 months |
| `lts`    | 12 months            | 36 months from release                  |

Set on the release when it is published. **Dates only ever move later** — `extendSupport` refuses
to shorten one, because teams plan upgrades against them and moving a Q3 date to Q1 strands
exactly the deployments that were being responsible.

An unregistered version is treated as unsupported: nobody has committed to fixing it.

---

## 5. Deprecation

Announce in the release that introduces the replacement, with the version it will be removed in:

```ts
deprecations: [{ what: 'Foo.bar()', replacement: 'Foo.baz()', removedIn: '0.8.0' }];
```

Minimum one minor between announcement and removal; for anything in a generated application's
public surface, one major. A deprecation announced and removed in the same release is a breaking
change with a courtesy note attached.

---

## 6. Withdrawing a release

A published release that turns out to be dangerous is **withdrawn, never deleted**:

```ts
manager.withdraw('0.5.0', 'Data loss on upgrade from 0.3.');
```

A reason is required. The release stays in the register — deployments already on it need to know
what happened, and a version that vanishes leaves them with no explanation and no path. A
withdrawn release is end-of-life whatever its dates said, and `trustos upgrade` refuses it as a
target.

---

## 7. Security releases

1. Fix on the lowest supported branch that has the flaw.
2. Forward-port to every supported branch. A fix on `main` only is a fix nobody in production has.
3. Note it in `securityFixes` — `recommendUpgrade` reads that and raises the urgency to
   `required`, which is the only thing that makes an upgrade non-optional.
4. Publish the notes with the fix, not before.

`required` is reserved for a security fix or an out-of-support version. Everything else is
`recommended` at most: an upgrade a team is told they must do, for no stated reason, is an upgrade
they learn to ignore.

---

## 8. Checklist

- [ ] Lint, format, build and tests green
- [ ] `trustos architecture-check` clean
- [ ] Quality gates pass, or every waiver has an owner and an unexpired date
- [ ] `VersionEntry` added, breaking changes listed with what to change
- [ ] `Release` registered with channel and — for stable/lts — support dates
- [ ] Compatibility matrix updated for anything verified against this version
- [ ] `trustos docs --write` run and the diff reviewed
- [ ] Migration notes written for every breaking change
- [ ] Deprecations carry a `removedIn`
