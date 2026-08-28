# @trustos/module-feature-flags

**Feature Flags** · v0.1.0 · stable · owned by TrustOS Platform Engineering

Boolean flags with percentage rollout, per-organization overrides, environment scoping and expiry dates, over a REST API.

```bash
trustos add-module feature-flags --path ../my-app --framework-path .
```

Boolean flags with percentage rollout, per-subject overrides, environment scoping and
expiry, over a REST API.

```ts
await flags.create({ key: 'new-checkout', description: 'The new checkout flow.' }, organizationId);
await flags.update('new-checkout', { enabled: true, rolloutPercentage: 10 }, organizationId);

if (await flags.isEnabled('new-checkout', organizationId, { subjectId: user.id })) {
  // 10% of users, stably
}
```

## Every rule can only turn a flag off

That is the safety property. Evaluation applies, in this order:

1. unknown flag → **off** (a typo must not enable a feature)
2. expired → **off** (an expiry honoured by remembering to delete the flag is not an
   expiry)
3. wrong environment → **off**
4. per-subject override → **its value** (the one step that can return true against a
   partial rollout, and it is a row somebody created)
5. disabled → **off**
6. rollout: 100 on, 0 off, otherwise bucket the subject
7. partial rollout with no subject → **off** (guessing would make the flag flap per
   request)

Expiry and environment are checked _before_ overrides, so a per-subject allow-list in
staging cannot leak a feature into production.

## Bucketing

`sha256(salt:key:subject)`, first four bytes, modulo 10,000. Three properties, and a
rollout is only usable if all three hold:

- **Stable** — the same subject gets the same answer in every process. A random draw
  per request flickers the feature in and out mid-session, which reads as a broken
  product.
- **Independent per flag** — the key is in the hash, so the first 10% of one rollout
  is not the same people as the first 10% of the next.
- **Monotonic** — widening a rollout only adds subjects; nobody loses the feature.

The salt has a constant default rather than a random one: a salt that changed per
process would reshuffle every rollout on every deploy. Set
`FEATURE_FLAGS_ROLLOUT_SALT` once per environment.

## Tenant-specific by construction

Flags are per-organization rows, so "tenant-specific" is not a mode — it is the only
thing a flag can be. There is deliberately no platform-wide flag table: one mistake
on one row would otherwise enable a feature for every customer.

## Expiry

A flag can be given an expiry, bounded by `maxExpiryDays`. A flag with a ten-year
expiry is a permanent branch in the code with a date attached, which is the state
flags exist to prevent.

## Evaluation audit

Off by default: evaluations are hot — several per request — and the volume would drown
the rest of the audit trail. Turn it on per organization while investigating.

## Permissions

| Key                           | Description                         | Suggested roles                                      |
| ----------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `feature-flags.flag.read`     | List flags and their configuration. | organization_owner, administrator, operator, auditor |
| `feature-flags.flag.manage`   | Create, change or remove a flag.    | organization_owner, administrator                    |
| `feature-flags.flag.evaluate` | Evaluate a flag for a subject.      | organization_owner, administrator, operator, auditor |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                               | Permission                    |
| ----------------------------------- | ----------------------------- |
| `GET /feature-flags`                | `feature-flags.flag.read`     |
| `POST /feature-flags`               | `feature-flags.flag.manage`   |
| `GET /feature-flags/:key`           | `feature-flags.flag.read`     |
| `PUT /feature-flags/:key`           | `feature-flags.flag.manage`   |
| `DELETE /feature-flags/:key`        | `feature-flags.flag.manage`   |
| `POST /feature-flags/:key/evaluate` | `feature-flags.flag.evaluate` |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable         | Purpose                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FEATURE_FLAGS_ROLLOUT_SALT` | Salt for percentage-rollout bucketing. Changing it reshuffles every rollout, so set it once per environment. |

### Feature flags

- `feature-flags.audit-evaluations` (default off) — Write an audit record for every evaluation. Off by default: evaluations are hot and the volume would drown the trail.

## Database

- `prisma/schema/25-feature-flag.prisma` — FeatureFlag and FeatureFlagOverride tables.

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port               | Purpose                                          | Ships                    |
| ------------------ | ------------------------------------------------ | ------------------------ |
| `FeatureFlagStore` | Where flags and per-organization overrides live. | `PrismaFeatureFlagStore` |

## Depends on

None.

## Out of scope

- Third-party flag services (LaunchDarkly, Unleash)
- Streaming flag updates to clients
- Multivariate and string-valued flags
- Experiment analysis

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/feature-flags
```

Unit, tenant isolation, RBAC where this module makes its own authorization decisions,
configuration validation and lifecycle. Isolation tests drive the Prisma store over
`FakeModelDelegate`, so they exercise `@trustos/tenancy` rather than a test double.

## Changes

### 0.1.0

Initial release.

## See also

- `AGENTS.md` — the invariants in this module that must not be weakened
- `docs/modules.md` — the module system
- `docs/module-development.md` — writing one
- `docs/module-versioning.md` — what counts as a breaking change
