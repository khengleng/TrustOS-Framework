# Product lifecycle

Eleven states, the transitions between them, and what each one requires. Everything here is
declared as data in `@trustos/financial-product-core`'s `lifecycle.ts` and executed by
`@trustos/financial-product-state-machine`.

- [The states](#the-states)
- [The transition table](#the-transition-table)
- [What a transition checks](#what-a-transition-checks)
- [Versions](#versions)
- [Version binding](#version-binding)
- [Rollback](#rollback)
- [Deprecation and retirement](#deprecation-and-retirement)

---

## The states

```text
  draft ──> design ──> validated ──> sandbox ──> under_review ──> approved
    ^          |           |            |             |               |
    └──────────┴───────────┴────────────┘             |            staged
              (revise, at any editable stage)         |               |
                                                   (reject)        active
                                                                   ↑   |
                                                            (activate) ├──> paused
                                                                       |      |
                                                                  deprecated <┘
                                                                       |
                                                                    retired
```

| State          | Meaning                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `draft`        | Being written. Editable, and executable nowhere                                      |
| `design`       | Structurally complete, under composition review. Still editable                      |
| `validated`    | Passes every static check: graph, blocks, connectors, rules, references              |
| `sandbox`      | Exercised against mock providers. Still editable — a sandbox run is not an approval  |
| `under_review` | Submitted for independent approval. **The definition freezes here**                  |
| `approved`     | Every required approval recorded. Immutable, and not yet reachable                   |
| `staged`       | Deployed to staging. Sandbox execution only                                          |
| `active`       | Live. **The only state in which the runtime executes a transaction**                 |
| `paused`       | Withdrawn from new transactions. Running executions finish under their bound version |
| `deprecated`   | Superseded. Existing integrations keep working; new ones are refused                 |
| `retired`      | Closed. No execution, no rollback target, history retained                           |

`EXECUTABLE_STATUSES` has one member. Everything above `active` in this table is a control that
exists to decide whether a definition may be added to that set, and adding a second member is a
security change rather than a convenience.

## The transition table

The shortcuts that are **absent** matter as much as the entries present. There is no
`draft -> active`, no `validated -> approved`, and no way to reach `active` except through
`approved` and `staged`. Every one of those would be a convenient thing to add during an incident
and a permanent hole afterwards.

| Action      | From               | To           | Permission                    | Needs approval |
| ----------- | ------------------ | ------------ | ----------------------------- | -------------- |
| `design`    | draft              | design       | `financial.product.update`    | no             |
| `validate`  | design             | validated    | `financial.product.validate`  | no             |
| `revise`    | validated, sandbox | draft        | `financial.product.update`    | no             |
| `sandbox`   | validated          | sandbox      | `financial.product.sandbox`   | no             |
| `submit`    | sandbox            | under_review | `financial.product.submit`    | no             |
| `reject`    | under_review       | draft        | `financial.product.approve`   | no             |
| `approve`   | under_review       | approved     | `financial.product.approve`   | **yes**        |
| `stage`     | approved           | staged       | `financial.product.publish`   | **yes**        |
| `activate`  | staged             | active       | `financial.product.publish`   | **yes**        |
| `pause`     | active             | paused       | `financial.product.pause`     | **no**         |
| `activate`  | paused             | active       | `financial.product.publish`   | no             |
| `deprecate` | active, paused     | deprecated   | `financial.product.deprecate` | **yes**        |
| `retire`    | deprecated         | retired      | `financial.product.retire`    | **yes**        |

**`pause` deliberately needs no approval.** An incident response that waits for a checker is not
an incident response, and every second between "we know" and "it stopped" is transactions. It is
also the one governed action whose failure mode is "we stopped too much" rather than "we allowed
too much".

**`activate` from `paused` needs no approval either.** The version being restored was already
approved; requiring a second approval to undo an emergency pause would mean the emergency is not
over until a meeting happens.

## What a transition checks

Four preconditions, all loaded server-side, none of them a field a client could supply.

**Permission.** Does the actor hold the key the transition names?

**Self-approval.** On `approve` and `reject`, is the actor the recorded author of the version? A
maker who can approve their own product is not a control; it is a log entry that looks like one.
The check compares against the author the registry recorded from the actor at creation, never
against a submitter field in a request.

**Outstanding approvals.** Which levels does this change require, and which have recorded an
approval? The required set is **derived from a diff** rather than declared — see
[product-governance.md](product-governance.md). A product owner asked which approvals their change
needs will answer with the ones they remembered.

**The definition hash.** From `under_review` onward, does the definition still hash to what the
reviewers saw? If not, their approvals approve a different product. The hash covers reviewed
content and deliberately **excludes `lifecycleStatus`** — otherwise pausing a product would break
every in-flight execution during exactly the incident the pause was handling.

`checkLifecycleTransition` returns **every** refusal rather than the first. A product owner who
fixes one and resubmits to find a second is a product owner who stops trusting the tool.

## Versions

A published version is a frozen document plus its provenance:

```ts
{
  productId, version, organizationId,
  contentHash,                    // what binds an execution to its rules
  publishedAt, publishedById,
  authoredById,                   // the maker. Compared against every approver
  approvedBy: [{ level, actorId }],
  supersedes,
  changeSummary,                  // required, and required to be substantive
  changedPaths,                   // derived, and what governance turned into approvals
  definition,                     // frozen
}
```

Three layers refuse an edit, and defeating any one defeats all three:

1. The record is frozen and every mutation path returns a new one.
2. `assertUnpublishedOrIdentical` refuses a write past the editable states.
3. **The content hash**, re-checked on every load rather than once. Caching the verdict would mean
   a definition edited between two executions is verified once and trusted afterwards.

The third is the one worth keeping when somebody argues the first two are enough. They are enough
against mistakes; the hash is what is left against everything else.

**Version bumps are checked against what changed.** A change to `blocks`, `transitions`,
`apiExposurePolicy` or `supportedCurrencies` is breaking for every channel calling the product,
and shipping one as a patch is refused. Below 1.0.0 the **minor** is the breaking position — the
framework-wide rule from phase 10, restated because it applies to products too, and because
getting it wrong is how a product at 0.9 breaks every channel on a patch release and calls itself
compliant.

## Version binding

**A transaction started on v2.1 runs on v2.1 until it ends.** That sentence is the whole of
`@trustos/financial-product-versioning`'s `binding.ts`.

The failure it prevents is specific. A payment authorized under a 0.5% fee and captured an hour
later, after the product moved to 0.75%, must settle at 0.5% — the merchant was quoted a price. A
system that re-resolved "the active version" at capture time would charge the new rate, agree with
every test, and disagree with the merchant statement. And because the transaction completed
successfully, nothing surfaces it until somebody reconciles by hand.

A binding records three things:

- the **version**, so the right rules load;
- the **content hash**, so a version edited outside the approval path is caught rather than run;
- the **lifecycle status at bind time**, so an execution that started while the product was active
  can finish after it was paused.

When a paused execution resumes — back from review, or a provider finally answered —
`assertBindingIntact` checks that it is still the same definition. It deliberately does **not**
check that the product is still active: that would kill every in-flight transaction the moment an
incident was handled, which is the opposite of what pausing is for.

## Rollback

v2.1 is live, an incident happens, v2.0 becomes live again. Two properties make it a control
rather than a redeploy.

**Nothing historical is rewritten.** Transactions that ran on v2.1 ran on v2.1 and keep saying so.
A rollback that relabelled them would destroy the only record of what rules a disputed transaction
was decided under — and a dispute about a transaction during an incident is the likeliest dispute
there is. `RollbackOutcome.historicalExecutionsRewritten` is typed as the literal `0`, so a test
can assert it and a future change cannot quietly make it non-zero.

**The target must already have been approved.** Rollback is not a second way to publish. A design
that let an operator name any version would be a way to reach production with one signature during
exactly the window when everybody is distracted.

The plan is produced first and reviewed:

```text
Rollback plan — merchant-wallet-basic
  New transactions would start on 1.0.0 instead of 1.1.0.
  12 execution(s) already bound to 1.1.0 will finish on it.
  Completed transactions keep recording 1.1.0. Nothing historical is rewritten.
  1.1.0 moves to "paused" and remains a rollback target itself.
  1.0.0 is older than 1.1.0; channels using anything added in 1.1.0 will start receiving refusals.
```

`applyRollback` takes the **plan**, not the arguments, so what was reviewed is what runs.
`--dry-run` is _not calling apply_ — never a second code path, because a tool with two paths stops
predicting the real run the first time they diverge.

## Deprecation and retirement

Deprecation signals without breaking: existing integrations keep working and new ones are refused.
Both `deprecate` and `retire` need approval, because both remove something somebody depends on.

A retired version is not a rollback target. That is deliberate: restoring something that was
closed is a new publication with its own review, not an undo.
