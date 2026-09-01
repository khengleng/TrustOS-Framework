# Consuming the framework from another repository

Everything in `packages/` is publishable. This is what a separate application repository —
SME OS, or anything after it — needs in order to install and build against it.

## The state of it

All 193 packages are publish-shaped and were audited to confirm it:

|                                                                          |                                 |
| ------------------------------------------------------------------------ | ------------------------------- |
| Packages with `main` and `types`                                         | 193 of 193                      |
| Declared entry points that exist on disk                                 | 193 of 193                      |
| `@trustsystem/*` dependencies pointing at something unpublishable        | 0                               |
| Packages depending on an application                                     | 0                               |
| Packages using `workspace:` or `file:` for a `@trustsystem/*` dependency | 0                               |
| Version drift                                                            | none — every package is `0.1.0` |

The last two matter most. Inter-package dependencies are written as exact versions
(`"@trustsystem/config": "0.1.0"`) rather than `workspace:*`, so a package installed from a
registry resolves its siblings from that registry with no rewriting at publish time. And
because nothing in `packages/` depends on anything in `apps/`, the publishable set is closed:
installing it never pulls in a deployable application.

`apps/*` and the repository root stay `"private": true`. They are deployed, not distributed.

## The one decision left

**Which registry.** It is not made here, because it depends on accounts rather than code.

`npm publish` without an explicit registry goes to `registry.npmjs.org`. These packages are
`UNLICENSED`, so the release script refuses to run without `--registry`, and every package
carries `publishConfig.access: restricted` as a second line of defence.

**Decided on 1 September 2026: GitHub Packages, under the `trustsystem` organisation.**

The constraint that drove it: **GitHub Packages requires the package scope to match the
repository owner.** The scope was `@trustos` and no such owner was available — `trustos` on
GitHub is a personal account registered in 2015 by an unrelated user, and GitHub shares one
namespace between users and organisations, so it can never be claimed for this project.

So the organisation `trustsystem` was created and the scope renamed to match it:
`@trustos/*` became `@trustsystem/*` across 241 manifests and 1,433 source files — 7,485
occurrences, verified by the full suite. Four forms of the token needed separate treatment,
and one of them must never be touched:

| Form             | Where                                                                    | Action         |
| ---------------- | ------------------------------------------------------------------------ | -------------- |
| `@trustos/`      | package names, dependencies, imports                                     | renamed        |
| `@trustos\/`     | inside regex literals, in the architecture validator and module registry | renamed        |
| `@trustos:`      | the `.npmrc` scope directive                                             | renamed        |
| `'@trustos'`     | a path segment joined into `node_modules/…`                              | renamed        |
| `@trustos.local` | an email default sender in the notification module                       | **left alone** |

The regex-escaped form is the one that matters. A plain search for `@trustos/` does not match
`@trustos\/`, so a naive rename leaves the validator and the registry silently failing to
recognise their own packages — passing tests, wrong behaviour.

**Renaming was cheapest now and never gets cheaper.** It was free today because no consumer
existed. Once SME OS installs anything, the same change is a breaking change for a consumer.

The rejected alternative was **npm with a private org**, which would have kept `@trustos`
intact with no rename at all, at a per-seat cost. Reasonable, and available if GitHub Packages
later proves awkward — the scope would have to change again.

## Publishing

**One prerequisite is outstanding:** the repository is still `khengleng/TrustOS-Framework`.
GitHub Packages resolves the scope from the _repository owner_, so publishing `@trustsystem/*`
requires this repository to live under the `trustsystem` organisation. Transfer it, or push a
mirror there and publish from that — until then the scope and the owner disagree and the
publish is refused.

```bash
npm run build:packages          # publish refuses if dist/ is missing
npm run release                 # dry run: what would publish, in what order
node scripts/release.mjs --registry https://npm.pkg.github.com --apply
```

Packages publish in dependency order — `shared-types` first, then everything that depends on
it. npm does not verify that a package's dependencies exist when publishing, so an arbitrary
order that fails halfway leaves a registry where some packages resolve to dependencies that
are not there. In dependency order, a partial publish is always a usable prefix, and re-running
reports what already exists rather than failing on it.

## Installing, from the consuming repository

`.npmrc` in the consuming repository, pointing the scope at the registry:

```
@trustsystem:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then generate the application with the CLI and let it write the dependencies:

```bash
npx @trustsystem/cli new erp --name smeos --package-name smeos
```

Without `--framework-path`, the generator writes `"@trustsystem/config": "^0.1.0"` and the rest as
ordinary registry dependencies. **Do not pass `--framework-path` for a separate repository** —
it writes `file:` specifiers containing an absolute path to a framework checkout, which works
on the machine that ran it and nowhere else, CI included. That flag exists for generating
inside this monorepo, which is what CI does.

## Until a registry exists

Two things work today without one:

- **Build inside this repository.** `apps/merchant-wallet-basic` is the worked example: a full
  application, 86.6% framework reuse on its payment path, no publishing involved.
- **Generate with `--framework-path`** for a local experiment, understanding that the result is
  not portable and cannot be committed as-is.

## Versioning

Every package is `0.1.0` and they move together. That is honest for a framework at this stage —
the packages are not independently stable and a consumer should take them as a set.

It stops being honest as soon as a second consumer exists and one of them needs a fix the other
cannot take yet. At that point this needs a real versioning tool. Nothing here forecloses that;
`scripts/release.mjs` publishes whatever versions the manifests carry.
