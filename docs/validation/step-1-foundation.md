# Step 1 — foundation validation

One scenario, driven end to end through the existing engines against a real Postgres
database in DEV.

Reproduce:

```bash
DATABASE_URL=<dev> TRUSTOS_ENVIRONMENT=dev npm run validate:foundation
```

Machine-readable output in `docs/validation/foundation-latest.json`. Exits non-zero on any
failure. There is no `PASS` constant in the script — every result is computed from what
the call actually did.

## The scenario

A User Access Change Request, on the framework's own `CHANGE_REQUEST_APPROVAL` definition:

```
draft ──submit──▶ manager_review ──approve──▶ approved
                        │
                        ├── maker's approval REFUSED
                        └── checker's approval ALLOWED
```

`submit` carries the instance through `submitted` into `manager_review` on its own — an
earlier version of this validation called `route_to_manager` afterwards and the engine
refused, correctly, because by then it was already in review.

Two organizations and six users are created in DEV, exercised, and deleted in a `finally`
block so a failed run leaves nothing behind.

## Results — 15/15

| Check                                                 | Result | Evidence                                                     |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------ |
| Scoped delegate reads its own tenant rows             | PASS   | membership found in A                                        |
| Scoped delegate refuses a cross-tenant read **by id** | PASS   | returned nothing for B's row                                 |
| Membership in A does not resolve in B                 | PASS   | `own=resolved other=null`                                    |
| The reverse direction also refuses                    | PASS   | `null`                                                       |
| **Requester cannot approve their own request**        | PASS   | `self_approval_forbidden`                                    |
| A different person may approve                        | PASS   | `eligible`                                                   |
| Definition carries every required transition          | PASS   | submit, approve, reject, return_for_rework, resubmit, cancel |
| `draft` cannot be approved directly                   | PASS   | transition absent from the definition                        |
| Request starts in `draft` and persists                | PASS   | instance row written                                         |
| Maker submits; it reaches review                      | PASS   | `manager_review`                                             |
| Engine refuses the maker's approval                   | PASS   | refused _(reason not attributed)_                            |
| Checker approves                                      | PASS   | `approved`                                                   |
| Instance is in Postgres in its final state            | PASS   | `state=approved org=A`                                       |
| A decision row was recorded                           | PASS   | 1 row                                                        |
| Audit log has no update path                          | PASS   | trigger refused the `UPDATE`                                 |

## Capability status

| Capability         | Status              | Evidence                                                                                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Authentication     | PARTIAL             | OIDC verified live earlier (signature, issuer, audience, `azp`, MFA). Not re-driven here — this scenario runs below HTTP |
| Multi-tenancy      | **PASS**            | four checks, both directions, including read-by-id                                                                       |
| RBAC               | PARTIAL             | role-gated transitions refused; a full ADMIN/MAKER/CHECKER/VIEWER matrix was not driven                                  |
| Policy             | PARTIAL             | the authorizer runs on every transition and refused one; no separate ALLOW/DENY decision record was captured             |
| Workflow           | **PASS**            | five states traversed and persisted                                                                                      |
| Maker-checker      | **PASS**            | `self_approval_forbidden` at the eligibility check; refused at the engine                                                |
| Audit              | PARTIAL             | append-only enforced at the database; the per-action audit trail was not enumerated                                      |
| Approval Workbench | **NOT_IMPLEMENTED** | a descriptor. No queue, no detail view, no service                                                                       |

## What this does not prove, stated plainly

**The self-approval refusal is not attributed.** The engine refuses the maker's approval —
including when the maker holds the checker role and its permissions, which removes the
obvious alternative explanation. But the message is _"You do not have permission to perform
this action"_, and it does not name separation of duty. Separation of duty is proven
explicitly one check above, where `checkApproverEligibility` returns
`self_approval_forbidden` for the requester and `eligible` for anyone else. Reading the
engine's generic message as proof of the rule would be claiming more than it says.

**Not everything in the scenario is persisted.** Workflow instances, versions, definitions
and decisions are Prisma-backed and were read back from Postgres. Tasks, history and SLA
use in-memory stores: they are not what this scenario proves, and implying the whole stack
was persisted would be the overclaim this exercise exists to prevent.

**This runs below HTTP.** It exercises the engines directly, not the deployed API. The
deployed surface is covered separately by `npm run validate -- --deployed`, which probes
authentication, headers and CORS live.

**The Approval Workbench was not made to work.** Section 12 asked for it to consume real
pending approvals. That means building an application — queue, detail, approve, reject,
rework, and a service behind them. It remains a descriptor, and its validation status
remains `not_tested`.

## Three false results this validation produced before it was right

Recorded because they are the failure mode the exercise is guarding against.

1. **A cross-tenant check that could not have failed.** It scoped `Organization` — the
   tenant itself, which has no `organizationId`. Prisma rejected the query outright.
2. **An append-only check that proved nothing.** It ran `UPDATE` against a table holding
   zero rows for that tenant. An `UPDATE` matching nothing succeeds trivially, because a
   row-level trigger never fires. It now inserts a record first, then tries to amend it,
   then reads it back unchanged.
3. **A message that was alarming and untrue.** When the scenario failed to start, the
   self-approval check printed `THE MAKER APPROVED THEIR OWN REQUEST`. It had not; the step
   was never reached. "Never reached" and "allowed" are different failures and only one is
   an emergency.

## Result

**PARTIAL — the foundation works; remediation is required before a product pilot.**

Tenant isolation, workflow and maker-checker are proven end to end against a real database.
Authentication, RBAC, policy and audit are individually implemented and tested but were not
driven through this scenario, so they are reported as PARTIAL rather than promoted on
adjacent evidence. The Approval Workbench does not exist.

No lifecycle or validation status is changed as a result of this run. Approval Workbench
stays `not_tested`, because nothing tested it.
