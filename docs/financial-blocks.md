# Financial blocks

The approved catalog: 84 blocks in 13 categories, what each entry declares, the three refusals the
schema makes, and how a deployment binds them to implementations.

- [What a block is](#what-a-block-is)
- [The catalog](#the-catalog)
- [What an entry declares](#what-an-entry-declares)
- [The three refusals](#the-three-refusals)
- [Ordering: what must run before what](#ordering-what-must-run-before-what)
- [Binding a handler](#binding-a-handler)
- [Adding a block](#adding-a-block)

---

## What a block is

The smallest unit of financial behaviour a product may contain: create a wallet, calculate a
percentage fee, consume a daily limit, post a journal.

**Products are composed from blocks and from nothing else.** There is no block that runs a script,
calls a URL or evaluates an expression, and there never should be. The moment one exists,
"products are composed from approved capabilities" becomes "…and also arbitrary code", and every
review that followed was reviewing the wrong thing.

**Every block is a contract, not an implementation.** The framework ships no handler for any of
them. The catalog knows what a debit _means_ — that it moves money, that it needs a preceding
limit, that it is undone by a reversal — and deliberately does not know which account it lands in.

## The catalog

| Category         | Blocks | Notes                                                                                                                                        |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`       | 7      | authenticate, verify_otp, kyc_check, customer_lookup, customer_eligibility, consent_check, device_check                                      |
| `wallet`         | 9      | create, activate, freeze, unfreeze, get_balance, hold_funds, release_hold, debit, credit                                                     |
| `payment`        | 7      | create, authorize, execute, verify, cancel, refund, query_status                                                                             |
| `transfer`       | 6      | p2p, wallet_to_bank, bank_to_wallet, merchant_payment, payout, bulk                                                                          |
| `ledger`         | 5      | create_journal, debit_account, credit_account, reverse_journal, verify_balance                                                               |
| `fee`            | 8      | flat, percentage, tiered, minimum, maximum, waiver, promotional, revenue_share                                                               |
| `limit`          | 6      | transaction, daily, monthly, velocity, wallet_balance, product                                                                               |
| `settlement`     | 6      | create, create_batch, execute, status, adjustment, close                                                                                     |
| `reconciliation` | 5      | match, identify_exception, queue_exception, resolve_exception, report                                                                        |
| `lending`        | 9      | check_eligibility, credit_assessment, loan_offer, calculate_interest, repayment_schedule, disburse, repay, apply_penalty, trigger_collection |
| `risk`           | 8      | aml_check, fraud_check, sanctions_check, pep_check, score, enhanced_review, manual_review, compliance_approval                               |
| `loyalty`        | 6      | member_account, earn, redeem, expire, transfer, campaign_reward                                                                              |
| `notification`   | 2      | send, acknowledge                                                                                                                            |

Eleven categories are the ones section 4 of the specification lists. Two are not, and the reason
each was added is worth stating:

- **`loyalty`** — the Loyalty Wallet template cannot be composed without earn, redeem and expire,
  and a template that ships without the blocks it needs is a template nobody can instantiate.
- **`notification`** — the reference architecture's worked example ends with "send notification",
  and a product that cannot tell a customer what happened is a product whose channel has to reach
  around it.

The catalog is **local data**. There is no remote fetch and no plugin resolution, for the same
reason `@trustos/module-registry` has none: a block is a capability a product may use without
further review, and a capability that can arrive over the network at runtime has not been
reviewed.

## What an entry declares

```ts
{
  blockId: 'wallet.debit',
  name: 'Debit wallet',
  category: 'wallet',
  version: '1.0.0',
  description: 'Moves money out. Posts through the ledger; the wallet balance is derived.',

  inputs:  [ { name, type, required, description, pii } ],
  outputs: [ ... ],
  configuration: [ ... ],

  requiredPermissions: ['financial.product.execute'],
  providerInterface: undefined,        // an interface name, never a vendor

  allowedNext: ['ledger.*', 'fee.*', 'settlement.*', 'notification.*'],
  requiresPrecedingCategories: ['limit'],

  monetaryEffect: 'moves',             // none | reserves | moves
  idempotent: true,
  compensatedBy: 'ledger.reverse_journal',

  auditEvents: ['wallet.debited'],
  emitsEvents: ['financial.product.execution.step_completed'],
  securityClassification: 'standard',  // standard | sensitive | restricted
  lifecycleStatus: 'approved',         // draft | approved | deprecated | withdrawn
}
```

Three kinds of information, and it is worth knowing which is which:

- **Contract** — inputs, outputs, configuration. What the composer validates a product against.
- **Consequence** — monetary effect, idempotency, compensation, events, permissions. What
  governance reads to decide who must approve a product containing it.
- **Position** — `allowedNext` and `requiresPrecedingCategories`. What catches the composition
  that is individually valid and collectively wrong.

`type` includes `money` and `rate` as their own types rather than strings with a comment. That is
the most load-bearing entry in the list: the composer can _check_ that a monetary field is carried
as minor units plus a currency, rather than trusting that whoever wrote the block remembered.

A field marked `pii` never reaches a log, an event or a metric dimension — the runtime keeps it
out, so a block author does not have to remember.

## The three refusals

The schema refuses three combinations outright, and each describes a block that would otherwise
look fine.

**A block that moves or reserves money must be idempotent.** Without it, a client timeout followed
by a retry moves the money twice, and the second movement is invisible to the caller.

**A block that moves money must declare what undoes it.** A step with no compensation leaves a
half-finished transaction that only a person can unwind, at 3am.

**A block that touches money must require something before it.** At minimum a limit. A composition
that debits with no preceding limit consumption authorizes the same money twice and fails at
settlement, after the customer was told it worked.

Two more, smaller:

- A deprecated block must name its successor. A deprecation with no successor is a dead end.
- A block carrying a `pii` field is at least `sensitive`. A `standard` classification on a block
  handling personal data is a classification nobody chose.

## Ordering: what must run before what

`requiresPrecedingCategories` is checked by the composer's dataflow analysis, over **every** path
rather than some path — see [product-composition.md](product-composition.md#the-ordering-check).

`allowedNext` is a list of exact block ids or category wildcards. An empty list means "any approved
block", which is right for a lookup or a notification and wrong for anything that moves money — so
every money-moving block in the catalog names its successors explicitly, and a test asserts it.

A failure path is exempt from `allowedNext`: on failure the product is unwinding, and the block it
unwinds to is chosen by the compensation rather than by the happy-path ordering.

## Binding a handler

```ts
const handlers = new BlockHandlerRegistry([
  {
    blockId: 'wallet.debit',
    async execute({ context, block, connector, priorOutputs, attempt }) {
      const result = await walletService.debit({
        organizationId: context.organizationId,
        walletId: String(context.input.references.wallet),
        amount: money(context.input.amountMinorUnits, context.input.currency),
        idempotencyKey: context.idempotencyKey,
      });

      return { outcome: 'success', outputs: { journalRef: result.journalId } };
    },
  },
  // …one per block the products in this deployment use
]);
```

A handler receives an already-authorized actor, an already-validated definition and an
already-consumed limit. It does not authorize, does not re-validate and does not decide whether it
should run — all three were settled before it was called, and a handler that repeated any of them
would be a second implementation that eventually disagrees with the first.

The result is a closed union of five outcomes, and the distinction between three of them is the
part that matters:

| Outcome             | Meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `success`           | It worked. `outputs` are available to later blocks and to transition conditions |
| `refused`           | A control said no. A limit, a rule, a risk decision. **The system working**     |
| `failed`            | The handler could not answer. A provider timed out, a store was unreachable     |
| `review_required`   | A person must decide. Everything up to here ran; nothing after it did           |
| `awaiting_provider` | An asynchronous instruction was sent and has not been answered                  |

`missingFor` reports which of a product's blocks have no handler, which is what a deployment check
runs at start-up. An unbound block **fails the execution loudly** rather than being skipped —
skipping it would skip a control.

## Adding a block

1. Add the entry to `packages/financial-block-registry/src/catalog.ts`. The schema will refuse it
   if it moves money without being idempotent, compensable and preceded by something.
2. Name a provider **interface** if it needs one. If no existing interface fits, adding one is a
   change to `connector-registry`'s closed list and a separate review — see
   [provider-abstraction.md](provider-abstraction.md).
3. Declare `allowedNext` explicitly if it moves money.
4. Add it to a template only if a template genuinely needs it.
5. Run `npx trustos financial-block list --category <name>` and read the row. If the row does not
   describe what you meant, neither will the catalog page.

Do **not** add a block that names a provider, a scheme or a jurisdiction. One vendor-named block
here makes every product containing it a product for that vendor, which is the coupling the whole
layer exists to remove — and the test suite fails on the word.
