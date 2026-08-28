# Consuming the framework from another repository

Everything in `packages/` is publishable. This is what a separate application repository —
SME OS, or anything after it — needs in order to install and build against it.

## The state of it

All 193 packages are publish-shaped and were audited to confirm it:

|                                                                      |                                 |
| -------------------------------------------------------------------- | ------------------------------- |
| Packages with `main` and `types`                                     | 193 of 193                      |
| Declared entry points that exist on disk                             | 193 of 193                      |
| `@trustos/*` dependencies pointing at something unpublishable        | 0                               |
| Packages depending on an application                                 | 0                               |
| Packages using `workspace:` or `file:` for a `@trustos/*` dependency | 0                               |
| Version drift                                                        | none — every package is `0.1.0` |

The last two matter most. Inter-package dependencies are written as exact versions
(`"@trustos/config": "0.1.0"`) rather than `workspace:*`, so a package installed from a
registry resolves its siblings from that registry with no rewriting at publish time. And
because nothing in `packages/` depends on anything in `apps/`, the publishable set is closed:
installing it never pulls in a deployable application.

`apps/*` and the repository root stay `"private": true`. They are deployed, not distributed.

## The one decision left

**Which registry.** It is not made here, because it depends on accounts rather than code.

`npm publish` without an explicit registry goes to `registry.npmjs.org`. These packages are
`UNLICENSED`, so the release script refuses to run without `--registry`, and every package
carries `publishConfig.access: restricted` as a second line of defence.

Two workable options:

- **GitHub Packages** (`https://npm.pkg.github.com`). Free for private packages and the code
  already lives on GitHub. One constraint decides whether it is viable: **GitHub Packages
  requires the package scope to match the repository owner.** The scope here is `@trustos`
  and the owner is `khengleng`, so this needs a GitHub organisation named `trustos` — or the
  packages renamed, which is 193 manifests and every import in the repository. Creating the
  organisation is much the cheaper of the two.
- **npm with a private org.** Owning the `@trustos` scope on npmjs.com works without
  renaming anything, and costs per seat.

## Publishing

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
@trustos:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then generate the application with the CLI and let it write the dependencies:

```bash
npx @trustos/cli new erp --name smeos --package-name smeos
```

Without `--framework-path`, the generator writes `"@trustos/config": "^0.1.0"` and the rest as
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
