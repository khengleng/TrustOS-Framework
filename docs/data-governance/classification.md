# Data classification

Five levels, and what each one _obliges_.

The important design decision is that a classification is not a label. `PUBLIC` and `RESTRICTED`
are not adjectives a reviewer argues about — each level maps to a table of concrete obligations, and
those obligations are what the rest of the framework reads. A level with no obligations attached is
a label somebody sets to whatever makes their ticket pass.

## The levels

| Level               | What it is                                             | Mask | Export | Reveal needs approval | Cross-region | Retention | Review | AI input |
| ------------------- | ------------------------------------------------------ | ---- | ------ | --------------------- | ------------ | --------- | ------ | -------- |
| `PUBLIC`            | Published documentation, product terms                 | no   | yes    | no                    | yes          | 365d      | 365d   | yes      |
| `INTERNAL`          | Operational data with no personal or financial content | no   | yes    | no                    | yes          | 730d      | 365d   | yes      |
| `CONFIDENTIAL`      | Merchant and customer profiles                         | yes  | yes    | no                    | yes          | 1825d     | 180d   | yes      |
| `RESTRICTED`        | Wallets, transactions, positions                       | yes  | yes    | yes                   | no           | 2555d     | 180d   | yes      |
| `HIGHLY_RESTRICTED` | Ledger, audit, credentials, keys                       | yes  | no     | yes                   | no           | 3650d     | 90d    | no       |

Read the row, not the name. "This is RESTRICTED" means _it is masked by default, a reveal needs a
second person, and it does not leave its region_ — and that sentence is what a reviewer can check.

Every column descends monotonically, which a test asserts. A table where `RESTRICTED` was somehow
more permissive than `CONFIDENTIAL` in one column would produce exactly one wrong decision and
nobody would notice which.

## Combining always takes the highest

```ts
combineClassifications(['PUBLIC', 'RESTRICTED']); // → 'RESTRICTED'
```

This is the rule that matters most in practice, and the one people are tempted to relax.

A report that joins a public reference table to a restricted transaction table and inherits
`PUBLIC` is a restricted extract with a public label. Nothing about the report says so; it looks
like a report about reference data that happens to have some numbers in it. Taking the highest is
what makes the join safe by construction.

The single exception is aggregation, and it is handled in lineage rather than here — see
[`lineage.md`](lineage.md).

## Inheritance catches the table classified before its columns existed

`DataCatalog.inheritedClassification` computes what an entry's children imply, separately from what
the entry declares:

```ts
catalog.inheritedClassification('db.merchant'); // → 'RESTRICTED'
catalog.require('db.merchant').classification; // → 'INTERNAL'
```

That gap is the finding. It happens the ordinary way: a table is registered and classified, and six
months later somebody adds a tax identifier column. The column is classified correctly. The table
is not reclassified, because nothing prompts anybody to.

`catalog.misclassified()` returns every entry in that state, and
`trustos data catalog <file>` exits non-zero when any exist.

## Personal data is a separate axis

`personalData` is a boolean on the catalog entry, independent of the level. It drives masking and
retention on its own, because a `CONFIDENTIAL` merchant name and a `CONFIDENTIAL` internal cost
figure need different handling and the level cannot tell them apart.

The schema refuses `personalData: true` at `PUBLIC`. If it genuinely is public, it is not personal
data; if it is personal data, publishing it is the finding.

## Extending the scale

`classificationExtensionSchema` lets a deployment insert a level, and it requires the same
obligation table every built-in level has. That is the point of allowing extension at all: a
deployment that needs `SECRET` between `RESTRICTED` and `HIGHLY_RESTRICTED` gets it, and gets it
with the obligations spelled out rather than as a name that behaves like whichever neighbour the
code happens to compare against.

## What the CLI tells you

```console
$ trustos data classify RESTRICTED
RESTRICTED

  Wallets, transactions, positions. Masked, exportable only under approval.

  Mask by default         yes
  Exportable              yes
  Reveal needs approval   yes
  Cross-region permitted  no
  Default retention       2555 days
  Review interval         180 days
  May be an AI input      yes
```

Deliberately prints obligations rather than a description. The description is what people argue
about; the obligations are what a reviewer needs.
