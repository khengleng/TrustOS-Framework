# Release process

Semantic versions, immutable artefacts, and the same build promoted from DEV to UAT.

## Where the version lives

`0.1.0` in the root `package.json`, and every workspace package carries `0.1.0` in lockstep.

That is deliberate for a framework at this stage: 171 packages versioned independently is 171
compatibility questions, and nobody consuming TrustOS today needs `@trustsystem/ledger` at a different
version from `@trustsystem/wallet`. When somebody does, `@trustsystem/compatibility-engine` is the package
that will answer it.

## The tags

```text
v0.1.0-alpha    the framework builds, tests pass, images build
v0.1.0-pilot    a pilot has run against it and the evidence exists
v0.1.0          production criteria met
```

**Not `v1.0.0` until the production criteria are met**, and they are not. See
[`../deployment/pilot-readiness.md`](../deployment/pilot-readiness.md) — two items are FAIL and
several are PARTIAL.

A `1.0` on a framework says the API is stable and the operational story is proven. Neither is true
yet, and a version number that says otherwise is the cheapest possible way to mislead somebody.

## The flow

```text
feature branch
     ↓
pull request
     ↓
CI — verify, templates, modules, generated, security, deployment
     ↓
review
     ↓
merge to main
     ↓
tag
     ↓
build once
     ↓
deploy DEV
     ↓
smoke tests
     ↓
promote the same artefact to UAT
     ↓
validation
```

**Build once.** The artefact deployed to UAT is the one that was built for DEV and passed its smoke
tests. Rebuilding for UAT is building different bytes from the same source — a different
`node_modules` resolution, a different base image digest — and then the thing that was tested is
not the thing that is running.

Configuration stays external. That is what makes one artefact promotable.

## Branching

`main` is always deployable. Work happens on a branch and reaches `main` through a reviewed pull
request.

There are no long-lived release branches. A framework that supports one version does not need
them, and they are the thing that turns a security fix into three cherry-picks.

## Tagging

```bash
git tag -a v0.1.0-alpha -m "TrustOS v0.1.0-alpha"
git push origin v0.1.0-alpha
```

Annotated, so the tag carries an author and a date. A lightweight tag is a pointer with no
provenance.

## Publishing packages

**Not automated, and not published.**

The readiness specification says to configure publishing readiness and not to publish without
explicit approval. Every package is `"private": true`, which is what stops an accidental `npm
publish` from reaching the public registry.

When a private registry is adopted:

1. Set `publishConfig.registry` on each package.
2. Remove `"private": true` from the packages intended for consumption — **not all 171**. Most are
   internal to the framework and publishing them commits to their API.
3. Publish from a tag, from CI, with a token that has no other scope.

Step 2 is the decision, and it should be made once, deliberately, with a list.

## Rolling back

```bash
railway deployment list --service trustos-api
railway redeploy <deployment-id>
```

**A code rollback is not a schema rollback.** If the deploy included a migration, redeploying the
previous image gives old code against a new schema. Read
[`../deployment/database-migrations.md`](../deployment/database-migrations.md#when-a-migration-goes-wrong)
before doing it — the recovery is forward, with a new migration.

## Emergency fixes

The process does not change. It gets faster because the change is small.

```text
branch from main
     ↓
the smallest possible fix
     ↓
CI — every gate, none skipped
     ↓
one reviewer
     ↓
merge, tag, deploy
```

**No gate is skipped**, and that includes the security gates. A fix that cannot pass the tests is a
fix nobody has evidence for, applied under time pressure, to production. AGENTS.md states it as a
rule: never disable a test to make CI green.

If a gate is genuinely wrong about the fix, the exception process in
[`../security-testing.md`](../security-testing.md#the-exception-process) records it with an owner
and an expiry — which takes a minute and leaves something to review afterwards.
