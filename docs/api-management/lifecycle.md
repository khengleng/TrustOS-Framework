# API lifecycle

```text
DRAFT → REVIEW → APPROVED → PUBLISHED → DEPRECATED → RETIRED
```

## Two properties of the transition table

**`PUBLISHED` cannot go back to `DRAFT`.** Once consumers exist, changing the contract is a new
version, not an edit.

**`RETIRED` is terminal.** Un-retiring means consumers were told it was gone and then it was not,
which is worse than a new version at the same path.

## Publishing into production is not self-service

```ts
catalog.transition({ apiId, version, to: 'PUBLISHED', actorId, reason });
// Refuses when actorId is the business owner or the technical owner.
```

The same self-approval the framework refuses everywhere else. An API going live is exactly as
consequential as the changes maker-checker protects: it creates a contract with callers who did not
consent to it, and withdrawing it later is expensive.

The check lives in the catalog rather than in a controller so it holds for every caller including
the CLI. A control that exists in one controller is a control with a bypass.

Outside production the gate does not apply — it protects consumers, and a development API has none.

## Two owners, both required

The **business owner** decides whether a consumer gets an exception. The **technical owner** decides
whether a change is safe.

Collapsing them means one of those decisions gets made by whoever is nearest.

## A deprecation with no date is an announcement

The schema refuses `DEPRECATED` without `retirementDate`. Without one, nobody has to act.

`supersededBy` is optional, and its absence says something: a deprecation with no successor is a
withdrawal, and the record should show that rather than implying a migration exists.

## A retirement date is only real if you can see who has not moved

```ts
catalog.analyse({ consumersOf: (apiId, version) => consumers.consumersOf(apiId, version) });
// → deprecated_with_active_consumers: "retires on 2026-12-01 and 4 consumer(s) have not moved: ..."
```

Deprecation is a promise made to specific callers. `consumersOf` is supplied by the caller rather
than held in the catalog, so the catalog needs no dependency on the consumer registry — but the
relationship it reports on is what makes the date actionable.

## What the catalog reports

| Finding                            | Severity | Why                                                                  |
| ---------------------------------- | -------- | -------------------------------------------------------------------- |
| `published_without_approval`       | high     | Live in production with no recorded governance approval.             |
| `deprecated_with_active_consumers` | high     | The date will break specific, named callers.                         |
| `retired_but_called`               | high     | Retired, and consumers are still entitled.                           |
| `undocumented`                     | medium   | Published with no OpenAPI reference; the portal has nothing to show. |
| `no_objective`                     | low      | Published in production with nothing consumers can rely on.          |

```console
$ trustos api catalog apis.json
```

Exits non-zero on any high-severity finding.
