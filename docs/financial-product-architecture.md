# Financial product architecture

Phase 11 is a **composition layer**: a way to define a financial product once, from tested and
approved capabilities, and reuse it across every channel — rather than implementing the same fee,
the same limit and the same settlement rule in payKH, in dbank and in the next application, three
times, slightly differently.

> **This layer builds no product.** It ships no merchant wallet anybody can sell, no bank
> integration, no scheme and no jurisdiction's rules. What it ships is the machinery that lets a
> product owner assemble one, and the governance that decides whether it may go live.

- [The five rules](#the-five-rules)
- [Where it sits](#where-it-sits)
- [The idea in one page](#the-idea-in-one-page)
- [The packages](#the-packages)
- [A transaction, end to end](#a-transaction-end-to-end)
- [What is deliberately absent](#what-is-deliberately-absent)
- [The seams a deployment fills](#the-seams-a-deployment-fills)
- [Running it](#running-it)

---

## The five rules

Everything in this phase follows from five rules, and each is enforced rather than documented.

**1. A product is composed from approved blocks, and from nothing else.** There is no block that
runs a script, evaluates an expression or calls a URL, and the composer has no method that would
add one. The moment such a block exists, "products are composed from approved capabilities"
becomes "…and also arbitrary code", and every review that followed was reviewing the wrong thing.

**2. A published version never changes.** Not its fees, not its limits, not a typo in its
description. A running transaction reads its rules from a version record, so editing that record
retroactively changes the rules a decision was made under — and unlike a workflow, the decision
here moved money. Three layers refuse it; the third is a content hash, which is what survives
somebody editing the row directly in the database.

**3. A transaction started on v2.1 runs on v2.1 until it ends.** A payment authorized under a 0.5%
fee and captured an hour later, after the product moved to 0.75%, settles at 0.5% — the merchant
was quoted a price. A system that re-resolved the active version at capture time would charge the
new rate, agree with every test, and disagree with the merchant statement.

**4. A product never names a provider.** A block declares that it needs a `PaymentProvider`; a
connector says some external system implements `PaymentProvider.execute`; nothing in a product
definition names a vendor. Swapping the rail underneath is a connector change reviewed by security
and operations, and the product's approved definition does not move.

**5. A refusal is not a failure.** A limit reached, a rule denied, a risk decision — those are the
system working, and they end in `refused`. A provider timeout is the system not working, and it
ends in `failed`. Collapsing them makes every dashboard report a product enforcing its limits
correctly as a product that is broken, and the alert that matters gets muted within a week.

## Where it sits

```text
  Channels          payKH    dbank    merchant apps    partner APIs
                      |
                      v
  Phase 11        FINANCIAL PRODUCT COMPOSITION LAYER
                      |        composer · rules · lifecycle · runtime
                      |        variants · versioning · governance
                      |        sandbox · simulator · API exposure
                      v
  Phase 8         FINANCIAL PRIMITIVES
                      |        ledger · wallet · fees · limits
                      |        settlement · reconciliation · transactions
                      v
  Phase 6         INTEGRATION
                      |        adapters · retry · circuit breaker · events
                      v
  External        banks · KYC · AML · credit bureaux · core banking
```

Phase 11 sits **across** phases 4 through 10 rather than on top of any one of them. It reuses
identity and RBAC for who may act, the workflow framework's approval models for maker-checker, the
financial primitives for what a block means, the integration framework for how a provider is
reached, and the platform packages for versioning and architecture validation.

## The idea in one page

An API tells the platform **how** to perform an action. A product decides **when** it is allowed,
what must happen before and after it, which limits apply, which fees apply, which approvals are
required, and what happens when something fails.

A bank exposes `POST /transfer`. The product is not that endpoint. The product is:

```text
authenticate -> validate customer -> check wallet -> check KYC -> consume limit
  -> risk check -> calculate fee -> reserve funds -> execute transfer
  -> post ledger -> settle -> reconcile -> notify
```

That sequence, with its conditions, its failure paths and its approvals, is what this layer stores,
versions, approves and executes. Two channels calling the same product get the same behaviour,
because there is one definition and neither of them implements any of it.

## The packages

Sixteen, and they divide into four groups.

**Vocabulary** — what a product _is_.

| Package                    | What it owns                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `financial-product-core`   | The definition document, the lifecycle table, reference data, the rule shape, permissions, and the ports the runtime reaches the world through |
| `financial-block-registry` | 84 approved blocks in 13 categories, and the refusals that catch a block which moves money and cannot be undone                                |
| `connector-registry`       | Seven provider interfaces with closed operation lists. The framework's own catalog ships empty                                                 |

**Composition** — how one is built.

| Package                           | What it owns                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `financial-product-composer`      | The builder, the validator, six templates and the AI draft path                             |
| `financial-product-rules`         | The deterministic engine: a closed fact map, first-wins conflict resolution, an explanation |
| `financial-product-variants`      | Controlled override with provenance. No field for blocks or transitions                     |
| `financial-product-state-machine` | The governance lifecycle and the execution states, as declared tables                       |

**Governance** — whether it may go live.

| Package                        | What it owns                                                             |
| ------------------------------ | ------------------------------------------------------------------------ |
| `financial-product-governance` | Change classification derived from a diff, and the approvals that follow |
| `financial-product-policy`     | Separation of duties on the phase 4 engine. Every policy can only refuse |
| `financial-product-versioning` | Immutable versions, content hashing, version binding, rollback planning  |
| `financial-product-registry`   | The catalog, and the only place a product changes state                  |

**Execution** — what happens when it runs.

| Package                           | What it owns                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `financial-product-runtime`       | Thirteen steps, in one order. Handlers, idempotency, failure paths, events, audit |
| `financial-product-sandbox`       | Mock providers, synthetic balances, twelve failure scenarios                      |
| `financial-product-simulator`     | Deterministic runs at volume, and a report that states what it does not mean      |
| `financial-product-api`           | Routes and OpenAPI generated from the definition, and a headless dispatcher       |
| `financial-product-observability` | A metric catalog where a dimension is a cardinality decision                      |

Plus `apps/financial-product-admin` — the Designer, and the integration proof that the sixteen
compose.

## A transaction, end to end

A channel calls `POST /v1/products/merchant-wallet-basic/payments`.

1. **The dispatcher** matches the route, checks the permission, refuses a missing idempotency key,
   applies the rate limit — in that order, each one able only to refuse.
2. **The registry** resolves the active version and **verifies its content hash**. A definition
   edited outside the approval path is refused here rather than executed.
3. **The runtime binds** to that version. Everything after this reads the bound definition; the
   active version is never re-resolved.
4. **The idempotency key is claimed.** A duplicate with the same payload returns the stored result;
   a duplicate with a different payload is refused rather than replayed.
5. **The rules are evaluated once**, against a fact map built from the context. A rule may set a
   fee, impose a limit, demand a review, choose a connector or refuse.
6. **The graph is walked.** Each block resolves its handler and its connector, runs through the
   retry policy the product declared, and records a step.
7. **A failure compensates** if the block declares compensation, and `compensation_failed` is its
   own state — an execution whose compensation failed needs a person.
8. **Events, audit and metrics** are written throughout, and the result is stored against the
   idempotency key.

## What is deliberately absent

| Absent                         | Why                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Any provider, rail or scheme   | The seam is the deliverable. One shipped here is one every deployment carries                                |
| Any block handler              | The catalog knows what a debit _means_ and stays out of which account it lands in                            |
| A credit scoring model         | A wrong one that everybody believed is worse than none                                                       |
| A currency or country table    | Both are a deployment's own. A partial list that looks complete is worse than none                           |
| A database schema for products | Which shape a definition takes is a deployment's decision. `ProductStore` is the port                        |
| An expression language         | The rule language is a structured predicate tree. Every convenient alternative is a code-execution primitive |
| A React designer               | The designer's data is here; its pixels are not. See [product-composition.md](product-composition.md)        |

## The seams a deployment fills

Six, and each one is an interface with no implementation in this repository.

| Seam            | Interface                                                | Bound to                                                                                 |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Block handlers  | `BlockHandler`                                           | `@trustsystem/wallet`, `@trustsystem/ledger`, `@trustsystem/fees`, `@trustsystem/limits` |
| Connectors      | `ConnectorDefinition` + `@trustsystem/adapter-framework` | The deployment's rails                                                                   |
| Product storage | `ProductStore`                                           | Prisma, with the three atomicity contracts the interface documents                       |
| Events          | `ProductEventPublisher`                                  | `@trustsystem/event-bus`                                                                 |
| Audit           | `ProductAuditRecorder`                                   | `@trustsystem/audit`                                                                     |
| Metrics         | `ProductMetricSink`                                      | The deployment's exporter                                                                |

## Running it

```bash
trustos financial-product list                      # the templates
trustos financial-product create merchant-wallet-basic --out product.json
trustos financial-product validate product.json     # the gate
trustos financial-product doctor product.json       # before asking anybody to review
trustos financial-product simulate product.json --count 100000 --seed 1
trustos financial-product publish product.json      # what publication would face
trustos financial-block list --category wallet
trustos connector list
```

Read next: [product-composition.md](product-composition.md) for how a product is built,
[product-lifecycle.md](product-lifecycle.md) for how it goes live, and
[financial-product-security.md](financial-product-security.md) before changing anything in the
runtime, the registry or the policies.
