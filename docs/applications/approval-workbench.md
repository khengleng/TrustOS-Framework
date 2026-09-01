# Approval Workbench

The first application built on the TrustOS foundation. It is the internal surface for
reviewing and deciding workflow approval tasks.

**The authoritative approval state stays in TrustOS Workflow.** The workbench composes a
queue, assembles a detail view and submits decisions. It enforces nothing of its own,
because everything it would enforce is already enforced where a second caller cannot skip
it.

## Purpose

One queue for every approval a person owns, whatever produced it — an access change, a
limit change, a product change, an adjustment. Without it, each workflow grows its own
review screen and the separation-of-duty rules drift apart.

## Users

| Who                | What they do                                                      |
| ------------------ | ----------------------------------------------------------------- |
| Reviewer / checker | Opens the queue, reads a request, approves, rejects or returns it |
| Maker              | Sees their own requests progress; cannot approve them             |
| Auditor            | Reads the decision trail and audit timeline                       |

Roles declared on the descriptor: `risk`, `compliance`, `finance`, `security`,
`product_owner`.

## Architecture

```
  Governance Tool
  ApprovalWorkbenchController          @RequirePermissions @Authorize @HumanActorsOnly
        |                              toWorkflowActor(actor, organizationId)
        v
  ApprovalWorkbenchService             composes; enforces nothing
        |
        +-- TaskService                eligibility from roles and groups, server-side
        +-- WorkflowEngine.transition  authorization, policy, maker-checker, decision,
        |                              task completion, audit — one call
        +-- decision store             decision history, incl. policyDecisionId
        +-- AuditService.query         read-only timeline
        |
        v
  Postgres
```

The ports in `packages/approval-workbench/src/ports.ts` are narrow on purpose: **the
shape of a port is the shape of the permission**. There is no port that writes an
instance, sets a state or creates a decision. The only mutation available is
`transition`.

## TrustOS dependencies

`@trustsystem/workflow-runtime`, `@trustsystem/workflow-tasks`, `@trustsystem/workflow-core`,
`@trustsystem/workflow-approvals`, `@trustsystem/workflow-history`, `@trustsystem/workflow-policy`,
`@trustsystem/workflow-sla`, `@trustsystem/authorization`, `@trustsystem/rbac`, `@trustsystem/tenancy`,
`@trustsystem/policy-engine`, `@trustsystem/audit`, `@trustsystem/identity`,
`@trustsystem/governance-workflow-bridge`, `@trustsystem/errors`.

Full accounting in [approval-workbench-reuse.md](../validation/approval-workbench-reuse.md).

## Permissions

| Route                                              | Method | Permission                                   |
| -------------------------------------------------- | ------ | -------------------------------------------- |
| `/api/governance/approvals`                        | GET    | `governance.console.approvals`               |
| `/api/governance/approvals/:instanceId`            | GET    | `governance.console.approvals`               |
| `/api/governance/approvals/:instanceId/decision`   | POST   | `governance.console.approvals` + human actor |
| `/api/governance/approvals/:instanceId/comments`   | POST   | `governance.console.approvals` + human actor |
| `/api/governance/approvals/tasks/:taskId/reassign` | POST   | `governance.console.approvals` + human actor |

The permission opens the workbench. It does **not** grant the right to decide: that is the
workflow definition's transition permission, checked inside the engine against the loaded
instance.

### Two surfaces, deliberately separate

The console descriptor declares its actions against `/internal/v1/operations/...` — the
**gateway** contract, whose paths are declared in `@trustsystem/governance-tool-integration`'s
operation catalog and asserted by an integration test. The routes in the table above are
what **this deployment** serves today.

They are not the same thing, and conflating them is a mistake worth recording: pointing
the descriptor at the Governance Tool's own routes left four console actions calling
gateway operations nobody had declared, and the integration test caught it.

## Classification

|                     |                             |
| ------------------- | --------------------------- |
| Data classification | **confidential**            |
| Risk classification | **high**                    |
| Owner               | `role:platform-engineering` |
| Lifecycle           | **draft**                   |
| Validation          | **PASS** in DEV — see below |

## User flows

**Approve** — open queue → open request → Approve → the submission carries the version the
screen was built at → engine authorizes, evaluates policy, applies maker-checker, records
the decision, completes the task, writes audit → the request leaves the pending queue and
appears under completed.

**Reject** — as above, with a required reason. The original request is never deleted.

**Return for rework** — required reason; the maker resubmits; a checker decides again. Both
cycles are kept.

## Security controls

| Control          | Where it is enforced                 | Observed                                                                      |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Authentication   | `@trustsystem/identity`              | Anonymous requests refused at the guard                                       |
| Human actor      | `@HumanActorsOnly`                   | A service account cannot be the checker                                       |
| Permission       | `@RequirePermissions` + `@Authorize` | Viewer refused: `transition_permission_missing`                               |
| Tenant isolation | `@OrganizationId` + scoped stores    | Cross-tenant read refused as **not found**, never forbidden                   |
| Maker-checker    | Workflow engine                      | Maker refused: `self_approval_forbidden`                                      |
| Concurrency      | `expectedVersion` optimistic lock    | Stale second checker refused: `stale_version`; one decision row               |
| Idempotency      | `runIdempotent`                      | Replayed approval: 1 → 1 decision rows                                        |
| Input tampering  | Strict zod schemas                   | A query or submission carrying its own tenant or actor is refused             |
| Tenant context   | `assertTenanted`                     | An actor with no organization is refused rather than querying an empty tenant |

## Validation evidence

```bash
DATABASE_URL=<dev> npm run validate:approval-workbench
```

**33/33 checks passed against the real DEV database**, error rate 0.0%. Machine-readable
output in [approval-workbench-latest.json](../validation/approval-workbench-latest.json).
Three scenarios — approve, reject, return-for-rework — driven end to end, with instances,
tasks, decisions and audit records written to Postgres and read back.

24 unit tests cover the application's own responsibility: that it delegates, and that it
cannot be talked out of delegating by its input. Four sabotages verified.

DEV timings, sampled (n=21): queue p50 47.8ms / p95 91.9ms; detail p50 147.9ms / p95
152.1ms; decide 756ms. Measured over a public database proxy from a developer machine, so
they carry the network twice and predict nothing about a production deployment.

## Known limitations

- **Comments are not wired.** `CommentService` exists in `@trustsystem/workflow-history`;
  this deployment does not construct it. The detail view reports comments as
  _unavailable_ rather than returning an empty list, because an empty list reads as
  "nobody commented".
- **Attachments are not wired.** Same reasoning. `DocumentPort.canRead` exists for when
  they are, so authorization will not need inventing.
- **Reassignment is not wired.** `TaskService.reassign` exists; the route refuses with
  `reassignment_unavailable` until a deployment supplies the port.
- **Filtering narrows the page, not the query.** `total` therefore counts what the store
  matched, not what survived the filter.
- **No browser UI.** The application is the API and the descriptor; the portal renders
  descriptors generically. A dedicated three-pane layout is not built.
- **Not exercised through deployed HTTP.** Validation drives the service against the real
  DEV database, below the HTTP layer, because DEV's machine-token credential is still
  outstanding. The controller's authorization decorators are therefore covered by
  convention and unit evidence, not by a deployed request.
