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

## Results — 21/21

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
| Engine refuses the maker's approval                   | PASS   | refused, recorded as `self_approval_forbidden`               |
| A viewer cannot approve                               | PASS   | refused — no decide permission                               |
| A checker in another organization cannot approve      | PASS   | refused with **not found**, not forbidden                    |
| Checker approves                                      | PASS   | `approved`                                                   |
| Instance is in Postgres in its final state            | PASS   | `state=approved org=A`                                       |
| A decision row was recorded                           | PASS   | 1 row                                                        |
| The scenario produced an audit trail                  | PASS   | 3 records: started, transitioned                             |
| Every record names an actor or the system             | PASS   | all 3, in tenant A                                           |
| The trail is scoped to the acting organization        | PASS   | all in tenant A                                              |
| Refusals recorded as security events                  | PASS   | `self_approval_forbidden`, `transition_permission_missing`   |
| Audit log has no update path                          | PASS   | trigger refused the `UPDATE`                                 |

## Capability status

| Capability         | Status              | Evidence                                                                                                                  |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | PARTIAL             | OIDC verified live earlier (signature, issuer, audience, `azp`, MFA). Not re-driven here — this scenario runs below HTTP  |
| Multi-tenancy      | **PASS**            | five checks, both directions, read-by-id, and a foreign checker refused at the engine                                     |
| RBAC               | **PASS**            | maker refused approval, viewer refused approval, checker allowed — the negative half driven, not assumed                  |
| Policy             | **PASS**            | every refusal produced a security event naming its reason                                                                 |
| Workflow           | **PASS**            | five states traversed and persisted                                                                                       |
| Maker-checker      | **PASS**            | `self_approval_forbidden` at the eligibility check **and** in the engine's event stream                                   |
| Audit              | **PASS**            | trail enumerated: 3 records, each naming an actor or the system, all scoped to the tenant; append-only enforced at the DB |
| Approval Workbench | **NOT_IMPLEMENTED** | a descriptor. No queue, no detail view, no service                                                                        |

## What this does not prove, stated plainly

**The refusal message stays generic, and that is deliberate.** The engine tells the caller
_"You do not have permission to perform this action"_ without naming which check refused —
telling a caller which of several checks stopped them is how a request gets iteratively
repaired. The reason is recorded where an operator can read it: the security event stream
carries `self_approval_forbidden`, and the validation now asserts that rather than reading
the generic message as proof.

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

## Four false results this validation produced before it was right

Recorded because they are the failure mode the exercise is guarding against.

1. **Two checks that blamed the framework for being right.** One required an `actorId` on
   every audit record and failed the automatic transition — which the engine records with a
   null actor and `actorType: 'system'` on purpose, because putting the maker's name on a
   transition the engine took would attribute a decision they did not make. The other then
   looked for `actorType` at the top level of the audit record, where the projection does
   not put it; it is inside `after`. Both times the framework was correct and the check was
   crude.
2. **A cross-tenant check that could not have failed.** It scoped `Organization` — the
   tenant itself, which has no `organizationId`. Prisma rejected the query outright.
3. **An append-only check that proved nothing.** It ran `UPDATE` against a table holding
   zero rows for that tenant. An `UPDATE` matching nothing succeeds trivially, because a
   row-level trigger never fires. It now inserts a record first, then tries to amend it,
   then reads it back unchanged.
4. **A message that was alarming and untrue.** When the scenario failed to start, the
   self-approval check printed `THE MAKER APPROVED THEIR OWN REQUEST`. It had not; the step
   was never reached. "Never reached" and "allowed" are different failures and only one is
   an emergency.

## Result

**PARTIAL — the foundation works; one gap remains before a product pilot.**

Multi-tenancy, RBAC, policy, workflow, maker-checker and audit are each proven end to end
against a real database, with the negative half of every control driven rather than assumed:
a maker refused their own approval, a viewer refused any approval, a foreign tenant's checker
refused with _not found_ rather than _forbidden_, and every refusal recorded with its reason.

Authentication stays PARTIAL because this scenario runs below HTTP — it is verified
separately and live by `npm run validate -- --deployed`, but it was not driven through this
path, and promoting it on adjacent evidence is the habit this exercise exists to break.

The Approval Workbench does not exist. That is the remaining gap, and it is an application
to be built rather than a control to be fixed.

No lifecycle or validation status is changed as a result of this run. Approval Workbench
stays `not_tested`, because nothing tested it.
