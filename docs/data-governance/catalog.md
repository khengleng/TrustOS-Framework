# The data catalog

Nine entity kinds, an owner and a steward on every entry, and a review date that expires.

## What is in it

`database`, `table`, `column`, `api_field`, `event_schema`, `report`, `document_type`,
`ai_knowledge_source`, `financial_object`.

The last three are the ones a conventional catalog omits, and each is where sensitive data escapes
notice:

- **`ai_knowledge_source`** — a retrieval corpus is a copy of production data with different
  access controls, and it is usually assembled by whoever built the feature.
- **`document_type`** — an uploaded identity document is not a row in a table, so a
  schema-derived catalog never sees it.
- **`financial_object`** — a ledger account is not a database concept, and a catalog that only
  knows tables cannot say that its balances are `HIGHLY_RESTRICTED`.

## Owner and steward are both required, and they are different things

The **owner** decides. Whether a field may be exported, whether a consumer may be granted access,
whether a classification is right — those are the owner's calls, and they are usually somebody in
the business.

The **steward** maintains. Keeping the entry accurate, running the review, noticing the new column
— that is the steward, and it is usually somebody in engineering or data.

Collapsing them into one field means one of those two jobs stops being done, and it is always the
first one: a technical owner will keep the record tidy and will not have an opinion about whether a
partner should see it.

## Registering

```ts
const catalog = new DataCatalog();

catalog.register({
  entryId: 'db.merchant',
  kind: 'table',
  technicalName: 'merchants',
  businessName: 'Merchant records',
  description: 'Registered merchants, their status and their contact details.',
  parentId: null,
  owner: 'usr_merchant_ops',
  steward: 'usr_data_gov',
  businessDomain: 'merchant',
  classification: 'CONFIDENTIAL',
  personalData: true,
  environment: 'prod',
  residencyRegion: 'eu-west',
  purpose: 'Operating merchant accounts and answering support enquiries.',
  legalBasis: 'Contract',
  lastReviewDate: '2026-01-01T00:00:00.000Z',
  nextReviewDate: '2026-12-01T00:00:00.000Z',
});
```

A column must name its parent, and the parent must already be registered. That ordering
requirement is not bureaucracy: `inheritedClassification` walks children upward, and an orphaned
column cannot participate — so the check that catches a wrongly-classified table would silently
skip it.

## Searching is authorization-aware

```ts
catalog.search({ text: 'merchant', authorized });
```

An unauthorized search returns a stub — id, business name, kind, classification, owner. Enough to
know the entry exists and who to ask; not enough to learn the schema.

The `authorized` flag is resolved **server-side from the actor's permissions**, never from a query
parameter. The `DataGovernanceController` does this explicitly, and the reason is that a query
parameter here would make the whole classification model a suggestion — and it is exactly the sort
of parameter added for a legitimate internal reason and then never removed.

## Reviews expire

`nextReviewDate` is required. `overdueReviews(asOf)` returns everything past it.

The interval comes from the classification: 90 days for `HIGHLY_RESTRICTED`, 365 for `PUBLIC`. A
catalog nobody reviews describes the system as it was when somebody last cared, which is worse than
no catalog because people trust it.

## Searching for what is wrong

```ts
catalog.misclassified(); // entries below what their contents imply
catalog.overdueReviews(now); // entries nobody has confirmed recently
```

Both are derived on read from the catalog itself rather than collected into a findings table. A
findings table needs a job to keep it fresh, and the job is the thing that stops running.
