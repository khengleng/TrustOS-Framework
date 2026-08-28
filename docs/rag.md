# Retrieval-augmented generation

Answering from your documents rather than from the model's memory. Chunking, embedding, search,
citations — and an access-control boundary that a naive implementation walks straight through.

- [The pipeline](#the-pipeline)
- [Collections and who may read them](#collections-and-who-may-read-them)
- [Chunking](#chunking)
- [Embeddings and comparability](#embeddings-and-comparability)
- [Search](#search)
- [Building the prompt](#building-the-prompt)
- [Citations](#citations)
- [Choosing a vector store](#choosing-a-vector-store)
- [What retrieval does not fix](#what-retrieval-does-not-fix)

---

## The pipeline

```
  ingest:   document ──▶ chunk ──▶ embed ──▶ vector store
  answer:   question ──▶ embed ──▶ search ─┬─▶ fuse ──▶ diversify ──▶ format
                              keyword ─────┘                            │
                                                                        ▼
                                                            gateway.complete
                                                                        │
                                                                        ▼
                                                              checkCitations
```

Every step is replaceable. The vector store is an interface with an in-memory default; the
embedding provider is a port with a deterministic hashing implementation for tests. **Do not tie
an application to one vector database** — that decision changes, and everything above the
interface is written not to care.

## Collections and who may read them

A collection defaults to `restricted`. That default is the most important line in the package.

A knowledge base that defaults to readable is a knowledge base that answers questions for people
who should not have asked, and the symptom is an answer that is correct, well-cited and a leak.

```ts
await knowledge.createCollection(
  {
    key: 'hr-policies',
    name: 'HR policies',
    visibility: 'restricted',
    readPermissions: ['hr.documents.read'],
    embeddingModelId: 'text-embedding-3-small',
    dimensions: 1536,
  },
  { organizationId, actorId },
);
```

| Visibility     | Who reads it                                         |
| -------------- | ---------------------------------------------------- |
| `public`       | anyone in the tenant                                 |
| `restricted`   | anyone holding every permission in `readPermissions` |
| `confidential` | as `restricted`, and never cached                    |

`canRead` returns a **reason**, not a boolean, so a refusal can say which permission was missing
rather than producing an empty answer that looks like "we have no policy on that".

Changing who may read a collection is audited as `rag.collection.access_changed`. It is the most
consequential edit in retrieval and the easiest to make by accident.

## Chunking

```ts
const chunks = chunkDocument(text, { maxChars: 1500, overlapFraction: 0.15 });
```

Recursive separator splitting: paragraphs, then sentences, then words. Three behaviours worth
knowing:

- **Headings are preserved onto the chunk that follows them.** A chunk reading "…must be approved
  by two people" is useless without "Refunds over $500".
- **15% overlap by default.** A fact split across a boundary is retrievable from neither side
  without it.
- **Tiny chunks are merged.** A three-word chunk retrieves for almost any query and answers none.

`assessChunking` reports what went wrong — oversized chunks that will crowd the context, fragments
that will pollute results — so a bad ingestion is visible before anybody searches.

## Embeddings and comparability

Two vectors are comparable only when three things match: the **model id**, the **dimensions** and
the **version**. Comparing vectors from different models produces similarity scores that look
completely normal and mean nothing.

The check is enforced on **both** sides:

- **On write**, so an incomparable vector never enters the index.
- **On read**, so a query embedded with a different model is refused rather than answered.

```ts
assertComparable(collection, queryVector, 'query');
```

The two messages differ, because the advice differs: a bad write is an ingestion bug to fix before
it spreads; a bad search is a caller using the wrong model right now.

Changing embedding model means **re-embedding the collection**. There is no migration path,
because there is no relationship between the old vectors and the new ones. Bump
`embeddingVersion`, re-ingest, and the comparability check keeps the two apart in the meantime.

## Search

Vector search finds passages that mean the same thing. Keyword search finds passages containing
the exact term. Neither is sufficient: vector search misses "ORD-1234", keyword search misses
"how long do I have to send it back".

Hybrid search runs both and fuses them with **reciprocal rank fusion**:

```
score(d) = Σ  1 / (60 + rank_i(d))
```

Fusion is on **rank**, not score, and that is not a detail. A cosine similarity of 0.82 and a BM25
score of 14.3 are not on comparable scales, and any attempt to weight them directly encodes an
arbitrary constant that stops being right the moment either backend changes.

`diversify` then drops near-duplicates. Five chunks from the same page crowd out the one from the
page that actually answers the question — and the model, seeing five agreeing passages, gets more
confident rather than less.

## Building the prompt

```ts
const context = formatContext(hits);
```

The formatted context does two things beyond concatenating passages:

1. Numbers each source `[1]`, `[2]`, … so the model can cite.
2. Tells the model to cite, and to **say when the sources do not answer the question**.

That second instruction is the one that matters. Without it, a model handed five passages about
refund windows and asked about chargebacks will write a fluent, confident paragraph about
chargebacks that is not in any of them.

## Citations

```ts
const check = checkCitations(answer, hits.length);

if (check.fabricated.length > 0) {
  // The model cited [4] and there were three sources.
}
```

A fabricated citation marker is the strongest single signal in a RAG system that something is
wrong: a model that invents `[4]` has stopped reading its context. It is a **fact**, not a
heuristic — unlike groundedness, which measures word overlap and is described honestly as such in
[evaluation.md](evaluation.md).

Track three numbers per deployment:

| Number                          | Meaning                                           |
| ------------------------------- | ------------------------------------------------- |
| Answers with no citation at all | The model is answering from memory.               |
| Fabricated markers              | The model has lost the context.                   |
| Groundedness                    | Only useful as a trend. Never as a truth measure. |

## Choosing a vector store

```ts
export class PgVectorStore implements VectorStore {
  readonly key = 'pgvector';
  async upsert(records: VectorRecord[]) {
    /* … */
  }
  async search(input: VectorSearchInput) {
    /* … */
  }
  // …
}
```

Two rules an implementation must follow:

1. **The tenant is part of the key, and checked again on read.** `InMemoryVectorStore` puts the
   organization in the collection key _and_ verifies it per record. That looks redundant and is
   not: a search that returns another tenant's passages returns them as a perfectly good answer.
2. **Call `assertComparable`.** Shared, so every adapter enforces it identically rather than five
   adapters each remembering.

The framework's default keeps vectors in memory, and the Prisma default keeps them as JSON. Both
are correct and slow. Anything with real retrieval volume wants pgvector, Qdrant or similar —
which is exactly why nothing above the interface knows which.

## What retrieval does not fix

Retrieval reduces hallucination. It does not eliminate it, and the framework does not claim
otherwise.

| Failure                                                                  | Retrieval helps?                             |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| The model invents a policy that does not exist                           | Yes, substantially                           |
| The model answers from a source that is out of date                      | No — that is an ingestion problem            |
| The model paraphrases a source into something subtly different           | No                                           |
| The model answers confidently when the sources do not cover the question | Only if you instruct it to refuse, and check |
| The sources themselves are wrong                                         | No                                           |

For anything where being wrong is expensive, retrieval is the first control and
[human review](human-review.md) is the second.

## Related

- [ai-architecture.md](ai-architecture.md) — where retrieval sits
- [evaluation.md](evaluation.md) — groundedness and what it does not measure
- [guardrails.md](guardrails.md) — the safety pipeline around the answer
- [ai-security.md](ai-security.md) — retrieved documents are untrusted input
