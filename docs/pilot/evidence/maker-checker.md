# Maker-checker evidence

Two shapes, both exercised.

## Merchant onboarding — a state machine across three people

```text
registered      usr_ops_maker     registers
                                  ↓
verified        usr_ops_checker   verifies, recorded as verifiedBy
                                  ↓
approved        usr_ops_manager   approves, recorded as approvedBy
```

| Test                                            | Result                                                      |
| ----------------------------------------------- | ----------------------------------------------------------- |
| Onboards through three distinct people          | **Pass** — `{createdBy, verifiedBy, approvedBy}` has size 3 |
| The verifier approving their own verification   | **Refused** — `forbidden`                                   |
| The registrar approving                         | **Refused** — `forbidden`                                   |
| Approving a merchant nobody verified            | **Refused** — the transition does not exist                 |
| Rejection with no reason                        | **Refused** by the schema                                   |
| Rejection permitting rework with no remediation | **Refused** — "say what to fix"                             |
| Every step audited                              | **Pass** — registered, verified, approved                   |

### Why the registrar is excluded as well as the verifier

A control that excluded only the immediately preceding actor is satisfied by one person
registering, a second verifying, and the first approving. Two people, one of whom did two of the
three steps — and the record would show three names.

`assertApprovable` refuses both.

### Why the check is on the record

It lives in `domain/merchant.ts`, not in a controller and not in a workflow. A merchant can be
approved through the API, a console or a migration script, and a control that lives in one of those
three is a control with two bypasses.

## A limit change — a request that exists separately

```text
usr_ops_maker    requests   daily limit 5,000 → 10,000, with a justification
                            ↓  nothing has changed
usr_finance      approves   with a reason
```

| Test                                         | Result                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| Nothing changes until approved               | **Pass** — the request is `pending` and the limit is untouched |
| The requester approving                      | **Refused** — `forbidden`                                      |
| Approval by a second person                  | **Pass** — `decidedBy` recorded                                |
| Deciding a request twice                     | **Refused** — "already rejected"                               |
| Deciding another tenant's request            | **Not found**                                                  |
| A request whose value equals the current one | **Refused** by the schema                                      |
| A rejection with no reason                   | **Refused** by the schema                                      |

### Why a request and not an audited edit

"Change the limit and audit it" is one line and it is not the same control.

The difference appears the first time a limit is raised at 2am by somebody who then leaves the
company. With a request there is a justification, a decision and a reason — three pieces of text
written by two people before anything moved. With an audited edit there is a row saying what
happened and nothing saying why it was allowed.

### Why a decided request cannot be decided again

Without it, a rejected request could be approved afterwards by somebody who did not see the
rejection — which is not a hypothetical, because a rejection and an approval are usually two
different people looking at the same queue.

## What the audit trail carries

```json
{
  "action": "mwb.limit.change_approved",
  "entityType": "limit_change_request",
  "entityId": "lcr_001",
  "actorId": "usr_finance",
  "organizationId": "org_a",
  "before": { "value": "500000" },
  "after": { "value": "1000000" },
  "metadata": {
    "reason": "The volume increase is consistent with the branch openings.",
    "requestedBy": "usr_ops_maker",
    "merchantId": "mer_alpha"
  }
}
```

`requestedBy` is in the metadata of the _approval_ record, so a reader of one record can see both
parties without joining anything. That matters during an investigation, where the join is the step
that gets skipped.
