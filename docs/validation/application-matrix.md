# Application validation matrix

The eleven applications registered in the Governance Tool, each inspected against the
criteria in section 2 of the validation brief.

## The single fact that determines every row

**All eleven are descriptors. None has an implementation.**

An `InternalApplication` is a declaration: pages, components, data sources, actions,
owners, classifications. The portal renders that declaration. There is no frontend, no
backend, no route and no table behind any of them. A directory search for implementing
code returns nothing for all eleven; two names collide with unrelated things
(`apps/sre-operations-console` is the SRE backend, `packages/case-management` is a domain
library), and neither implements the console it resembles.

That is what the Governance Tool is _for_ — a console is declared and rendered rather
than written — but it means every row below has the same answer for "frontend
implementation" and "backend implementation", and **no application may be promoted out of
`draft`.**

## The matrix

Counts are read from the descriptors themselves, not from documentation.

| Application                     | Pages | Components | Actions | Data sources | Data              | Risk         | Lifecycle | Validation |
| ------------------------------- | ----: | ---------: | ------: | -----------: | ----------------- | ------------ | --------- | ---------- |
| AI Operations Console           |     3 |          5 |       1 |            2 | confidential      | high         | draft     | NOT_TESTED |
| Approval Workbench              |     2 |          2 |       4 |            1 | confidential      | high         | draft     | NOT_TESTED |
| Case Management                 |     2 |          3 |       4 |            1 | restricted        | high         | draft     | NOT_TESTED |
| Customer Support Console        |     2 |          6 |       4 |            3 | restricted        | high         | draft     | NOT_TESTED |
| Enterprise Governance Console   |     5 |         12 |       6 |           12 | restricted        | high         | draft     | NOT_TESTED |
| Finance Operations Console      |     3 |          4 |       3 |            4 | restricted        | **critical** | draft     | NOT_TESTED |
| Financial Product Studio        |     5 |          6 |       5 |            2 | confidential      | high         | draft     | NOT_TESTED |
| Generic Dashboard               |     1 |          3 |       0 |            2 | internal          | low          | draft     | NOT_TESTED |
| Operations Console              |     4 |          7 |       4 |            5 | restricted        | high         | draft     | NOT_TESTED |
| Platform Administration Console |     4 |          6 |       2 |            6 | restricted        | **critical** | draft     | NOT_TESTED |
| Risk & Compliance Console       |     3 |          4 |       6 |            4 | highly_restricted | **critical** | draft     | NOT_TESTED |

Totals: 34 pages, 58 components, 39 actions, 42 data-source declarations.

`NOT_TESTED` is the honest validation state. It is not `FAIL` — nothing was found broken,
because there is nothing to break. It is not `PARTIAL` — no part of any of them executes.

## Per-application detail

The columns the brief asks for, answered once because the answer is identical:

| Criterion                  | Answer                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend implementation    | none — the portal renders the descriptor generically                                                                                                       |
| Backend implementation     | none                                                                                                                                                       |
| API dependencies           | declared, not wired. Data sources name `resourceId` and `operation`; no resource is registered, so every read would be refused with "no approved resource" |
| Database dependencies      | none of their own                                                                                                                                          |
| TrustOS capabilities used  | none at runtime. The declarations reference permissions and resources the framework defines                                                                |
| Authorization requirements | declared per page and per action, and enforced _if_ something executed them                                                                                |
| Working routes             | `GET /api/governance/consoles/:appId` returns the descriptor. That is the only route.                                                                      |
| Broken routes              | none — no route claims to do more than it does                                                                                                             |
| Missing functionality      | the implementation                                                                                                                                         |

### Where the underlying capability does exist

Three of these describe consoles over capabilities that are implemented and tested. The
console is missing; the engine is not.

| Application                | Underlying capability                                   | Its state                                                                          |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Approval Workbench         | maker-checker (`workflow-approvals`, `workflow-policy`) | IMPLEMENTED, 64 tests — self-approval refused, no role holds both halves of a pair |
| Case Management            | `packages/case-management`                              | IMPLEMENTED, 33 tests — create, assign, status, history                            |
| Finance Operations Console | `financial-core`, `ledger`, `wallet`, `limits`          | IMPLEMENTED, 184 tests — unbalanced journals refused, balance equals journals      |

Section 12 of the brief asked that the Approval Workbench be made to operate against the
real engine. Doing so means building an application — a queue, a detail view, approve,
reject and rework paths, and a service to back them. That is explicitly outside this
task's scope, so it is reported rather than built.

## Promotion

No application changes lifecycle as a result of this validation. `draft` is correct for
all eleven, and the promotion rule that would move one is in
[`trustos-v0.1-report.md`](trustos-v0.1-report.md): a descriptor becomes `implemented`
when something executes it, `validated` when that implementation passes functional and
security tests, and `active` only after that. Three of these are classified
**critical** risk, which warrants more evidence, not less.
