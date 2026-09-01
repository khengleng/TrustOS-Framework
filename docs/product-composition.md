# Composing a product

How a financial product is built, validated and designed — the composer, the validator's three
groups of finding, the templates, the visual designer's data model, and the path an AI proposal
takes to become a draft.

- [The composer](#the-composer)
- [The definition document](#the-definition-document)
- [Validation](#validation)
- [The ordering check](#the-ordering-check)
- [Templates](#templates)
- [Variants](#variants)
- [The visual designer](#the-visual-designer)
- [AI-assisted composition](#ai-assisted-composition)

---

## The composer

`ProductComposer` builds a definition from approved blocks. It has three properties worth knowing
before the API.

**It builds data, never behaviour.** `addBlock` records that a product uses an approved block with
a configuration. There is no `addScript`, no `addExpression`, no `addHandler`, and the test suite
asserts none of them exists. The composer's entire vocabulary is the block catalog plus the
restricted rule language.

**It refuses at the call that is wrong.** An unapproved block id throws at `addBlock` rather than
producing a definition that fails validation twenty calls later. In a designer, the error attaches
to the block somebody just dragged.

**It always emits a draft.** `build()` returns `lifecycleStatus: 'draft'` whatever the caller
asked for. Composition is not approval, and a composer that could emit `active` would be a way
around the entire lifecycle, reachable from a script in one line.

```ts
const definition = new ProductComposer({
  productId: 'merchant-wallet',
  productName: 'Merchant Wallet',
  productType: 'merchant',
  description: 'Payment acceptance with a ledger-backed balance.',
  version: '1.0.0',
  ownership: { businessOwner, technicalOwner, riskOwner, complianceOwner },
  supportedCurrencies: ['USD'],
  effectiveDate: '2026-01-01T00:00:00.000Z',
  reviewDate: '2026-12-31T00:00:00.000Z',
  compliancePolicy: { dataClassification: 'confidential', retentionDays: 2555 },
  auditClassification: 'sensitive',
})
  .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
  .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
  .addBlock({
    key: 'accept',
    blockId: 'payment.execute',
    blockVersion: '1.0.0',
    onFailure: 'compensate',
    compensateWith: ['refund'],
  })
  .addBlock({ key: 'refund', blockId: 'payment.refund', blockVersion: '1.0.0' })
  .connect('start', 'verify', 'always')
  .connect('verify', 'consume-limit')
  .connect('consume-limit', 'accept')
  .connect('accept', 'completed')
  .connect('refund', 'failed', 'always')
  .build();
```

## The definition document

Four conventions run through it, and each is here because the alternative fails quietly.

**Money is a string of minor units plus a currency code.** Never a JSON number. A number goes
through an IEEE double each way, and a fee cap of `1000.10` becomes `1000.0999999999999` — which
agrees with every test and disagrees with the counterparty.

**Rates are integers of hundredths of a basis point.** `0.5%` is `"5000"`. Same reason, plus one
more: a percentage written as `0.005` is read as half a percent by half the people who see it and
as 0.5 basis points by the other half.

**A block names a provider interface, never a provider.** `PaymentProvider`, not `ABA`.

**Everything the product decides is declared.** Limits, fees, settlement, reconciliation, risk,
compliance and API exposure are all fields. A product whose settlement schedule lives in a channel's
code settles differently in each channel, and nobody finds out until the two are reconciled against
each other.

## Validation

`validateProduct` returns findings in three groups.

**Resolution.** Does every block exist in the approved catalog? Is every provider-dependent block
bound to a connector implementing the right interface? Does a block configure retries when the
catalog says it is not idempotent?

**Graph.** Is every block reachable? Does every block lead somewhere? Is there a cycle? Does any
path reach `completed`? Does each transition respect the successor list the catalog declares?

**Ordering.** The group the package exists for — see below.

Findings are graded. An `error` refuses the product; a `warning` is recorded and shown. The split
matters: a shadowed rule is usually a mistake and occasionally a deliberate override left in for
documentation, and refusing the second case outright makes the validator something people work
around.

One severity is **contextual**: an unbound provider interface is a _warning_ when validating in
the abstract and an _error_ when a connector registry is supplied. A template deliberately binds
nothing; validating one with no registry has no way to know which connectors exist. Publication
passes a registry, and at that point an unbound interface means the product fails at that block on
a live transaction with earlier blocks already run.

## The ordering check

This is the one worth reading twice, because it catches the composition that is **individually
valid and collectively wrong**.

Eight approved blocks connected by legal transitions can still be a product that debits before it
checks a limit. Every block is approved. Every transition is allowed. The same money is authorized
twice, and the second capture fails at settlement — after the customer has been told both
succeeded.

The check is a dataflow analysis. For each block, it computes what has definitely run on **every**
path that reaches it — the _intersection_ across predecessors, not the union.

The intersection is the whole point. A union answers "has a limit check happened on some path",
and a product whose limit check sits on the branch that is not taken would pass:

```text
                    ┌── amount > 1000 ──> consume-limit ──┐
   verify ──────────┤                                     ├──> debit
                    └── amount <= 1000 ─> read-balance ───┘
```

Every block is approved, both transitions are legal, and half the transactions debit with no limit
consumed. The union-based analysis says the limit ran; the intersection-based one says it did not
run on every path, and refuses.

The fix is to move the limit before the branch, which is what every template does:

```text
   verify ──> consume-limit ──┬── DEBIT  ──> debit
                              └── CREDIT ──> credit
```

Compensating blocks are exempt, by construction: `ledger.reverse_journal` requires a preceding
`ledger` block and has one — the posting it is reversing — reached through the compensation path
rather than through a transition.

## Templates

Six ship, and every one **already validates**. A template a product owner has to fix before it
validates teaches them the validator is noise.

| Template                | Shape                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| `consumer-wallet`       | Onboarding, cash-in, P2P, merchant payment, cash-out                            |
| `merchant-wallet`       | Business verification, acceptance, refund, settlement, reconciliation           |
| `microloan`             | Eligibility, an external credit assessment, disbursement, repayment, collection |
| `bnpl`                  | A credit line, an instalment plan, immediate merchant settlement, repayment     |
| `loyalty-wallet`        | Earn, redeem, expire, transfer, on a ledger-backed points balance               |
| `merchant-wallet-basic` | The worked example: the whole layer end to end                                  |

They share a shape that is worth understanding, because it is what makes them validate: every
product opens with an authentication block and branches on `transactionType`. Not because every
product needs a dispatcher — because **a product is one graph**, and the operations a wallet offers
are branches of it rather than four separate documents. The alternative is four products called
"Consumer Wallet".

Two things they deliberately do not contain: **no provider**, and **no jurisdiction**. They are
denominated in `XTS` — the ISO 4217 code reserved for testing, which no country uses and no
provider settles — so a template deployed unchanged is caught by `trustos financial-product doctor`
rather than by a balance reported in the wrong currency.

## Variants

A variant is a **controlled override**, not a copy. It carries no blocks and no transitions, and
the schema has no field for either. That absence is the control: a variant that could reorder a
limit check and a debit could remove the limit check, and nothing in a variant review would show
it.

Three refusals, each of which would otherwise arrive looking like a configuration change:

1. **Widening a country or currency list.** The base was approved for a set of jurisdictions; a
   variant adding one puts live transactions somewhere nobody reviewed.
2. **Weakening a rule that denies or demands review.** A variant may make a control stricter and
   may not make it looser — including by replacing a rule with one that has dropped the outcome.
3. **Removing a fee or a limit.** Not expressible: the merge starts from the base list and only
   replaces or appends.

Resolution returns the effective definition **plus a provenance map** — which field came from
where. That is what a reviewer reads when asked "is this merchant on the standard rate", and what
an incident investigation reads when a variant behaves differently from the product it was
supposed to be a small change to.

## The visual designer

The designer's _data_ is in `@trustsystem/financial-product-composer/designer`; its pixels are not.
The admin application renders a canvas, the CLI renders a tree, a comparison view renders a diff —
three renderers over one description.

| Descriptor            | What it carries                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `designerPalette()`   | What may be dragged: approved blocks, grouped by category, with their configuration fields, whether they move money and what must precede them          |
| `designerCanvas()`    | Nodes with a layout column from the topological order, edges with their conditions rendered as text, and **findings attached to the node they concern** |
| `compareDesigns()`    | A node-level diff: blocks added, removed, changed; transitions added and removed; which configuration fields moved                                      |
| `DESIGNER_NAVIGATION` | The eleven sections section 22 of the reference architecture asks for                                                                                   |

The findings-on-the-node detail is what makes the designer usable by a business analyst. A
validation error in a list at the bottom of the screen is an error somebody scrolls past; one on
the block is one they fix.

**What is not shipped:** the React surface. It is a rendering decision that belongs to a
deployment's design system, and one shipped here would be one every deployment either adopts or
works around. The descriptors are complete enough to build it from.

## AI-assisted composition

A product owner describes a product in words; a model proposes a composition; **the proposal is
data, and it is validated before it becomes anything.**

The framework ships **no model call**. `buildCompositionBrief` produces the structured brief a
deployment sends through `@trustsystem/ai-gateway` — where policy, guardrails, cost accounting and
audit are applied — and `draftFromProposal` takes whatever comes back. Calling a model from this
package would be a call that went around the gateway.

Three properties make a proposal safe to accept:

**It is parsed, not trusted.** A proposal naming `wallet.transfer_everything` produces a refusal
naming that block, at the block, before a definition exists.

**It always lands in `draft`.** An AI-composed product enters the same lifecycle as a
hand-composed one and passes the same validation, sandbox, review and approval.

**It cannot supply owners, approvals or lifecycle status.** The proposal schema has no field for
any of them. A model that could nominate the risk owner could nominate one who does not exist, and
the approval requirement would be satisfied by nobody.

Everything the framework overrides is reported in `overrides`, which is the reviewer's first read:

```text
Dropped currencies the deployment does not support: EUR.
Dropped connector "rail-omega" on block "accept": it is not approved for this tenant.
Lifecycle status forced to `draft`.
```
