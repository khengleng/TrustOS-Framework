# Lineage

Declared, not scanned. Eight relation kinds. One of them may declassify, and only with a reason.

## Why declared

A lineage scanner reads queries and infers edges. It is genuinely useful and it is not the
authority here, for two reasons that both bite in practice:

A scanner sees the joins that ran. It does not see the export somebody wrote to a spreadsheet, the
extract a partner pulls monthly, or the retrieval corpus assembled from three tables by a script in
a notebook. Those are exactly the paths where classification gets lost.

And a scanner produces edges nobody owns. `LineageScanner` and `importScanned` exist so a
deployment can feed scanned edges in — they arrive with `source: 'scanned'`, which is visible, and
a person can promote them to `declared`.

## The relations

`copied_from`, `transformed_from`, `aggregated_from`, `published_as_event`, `exposed_via_api`,
`rendered_in_report`, `indexed_for_retrieval`, `replicated_to`.

`indexed_for_retrieval` is the one worth naming: it is the edge into an AI knowledge source, and it
is where restricted data most often ends up somewhere with different access controls.

## Classification propagates upward and only aggregation may lower it

```ts
graph.propagatedClassification('report.merchants', catalog); // → 'RESTRICTED'
catalog.require('report.merchants').classification; // → 'PUBLIC'
```

That gap is the finding, and `classificationDrift(catalog)` returns every entry in that state. A
report classified `PUBLIC` that is fed by a `RESTRICTED` table is a restricted extract with a
public label, and the report entry reads perfectly reasonably on its own.

The single relation permitted to declassify is `aggregated_from`:

```ts
export const MAY_DECLASSIFY = new Set(['aggregated_from']);
```

Aggregation genuinely can remove sensitivity — a count of transactions per country is not the
transactions. But the edge must state `declassifiesTo` **and** `declassificationReason`, because an
aggregate that declassifies without saying why is a re-labelling, and the label is what every
downstream control reads.

A `transformed_from` edge cannot declassify however aggressive the transformation looks. Hashing an
identifier does not make it non-personal; it makes it a pseudonym, and a pseudonym joined against
anything else is an identifier again.

## Finding what an outage or a change affects

```ts
graph.upstreamOf('report.merchants'); // what feeds it
graph.downstreamOf('db.merchant'); // what it feeds
```

Both are transitive with a depth bound. `downstreamOf` is the one to run before changing a schema:
it answers "what breaks", which is the question that gets asked after the change.

## Checking it from the CLI

```console
$ trustos data lineage catalog.json lineage.json
Lineage — 14 edges over 42 entries

  2 entry(ies) classified below what feeds them:
    report.merchants: declared PUBLIC, upstream implies RESTRICTED
    corpus.support: declared INTERNAL, upstream implies CONFIDENTIAL
```

Exits non-zero when drift exists, so it runs in CI.
