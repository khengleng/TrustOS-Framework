# Approval Workbench — framework reuse

The question this answers is whether the application genuinely uses TrustOS or merely
sits next to it. Everything below is counted from the repository at commit `1a9043c7744f`.

## What the application actually contains

|                                                             |   Lines | What it is                                              |
| ----------------------------------------------------------- | ------: | ------------------------------------------------------- |
| `packages/approval-workbench/src` (excl. tests)             |     818 | Ports, read models, the service                         |
| `apps/governance-tool/.../approval-workbench.controller.ts` |     163 | Five routes, authorization decorators, actor projection |
| **Application total**                                       | **981** |                                                         |
| `packages/approval-workbench/.../*.spec.ts`                 |     447 | 24 tests                                                |

Framework packages it consumes, counted the same way:

| Package                      |      Lines |
| ---------------------------- | ---------: |
| `workflow-runtime`           |      4,411 |
| `identity`                   |      2,460 |
| `workflow-history`           |      1,566 |
| `workflow-core`              |      1,290 |
| `workflow-tasks`             |      1,262 |
| `authorization`              |        815 |
| `tenancy`                    |        709 |
| `workflow-sla`               |        687 |
| `rbac`                       |        532 |
| `workflow-approvals`         |        523 |
| `workflow-policy`            |        518 |
| `audit`                      |        470 |
| `governance-workflow-bridge` |        262 |
| `policy-engine`              |        259 |
| **Total**                    | **15,764** |

**981 lines of application over 15,764 lines of framework** — a ratio of about 1:16.

That ratio is a measurement, not a claim about quality, and it is easy to misread. It does
not mean 94% of the application "is" framework; it means the application is thin because
the capabilities it needs already existed. A different application would consume a
different subset. What it does establish is that nothing large was rebuilt.

## Capability by capability

| Capability               | TrustOS component reused                                                               | Application-specific code                                                | Duplicated?                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Authentication**       | `@trustos/identity` — OIDC provider, token validation, `@HumanActorsOnly`              | None. The controller declares the decorator                              | **No**                                                                                         |
| **Tenant context**       | `@trustos/tenancy` — `@OrganizationId`, `scopedDelegate`                               | `assertTenanted`, which refuses an actor with no organization            | **No** — a guard against a caller that skips `toWorkflowActor`, not a second scoping mechanism |
| **RBAC**                 | `@trustos/rbac` — `@RequirePermissions`                                                | None                                                                     | **No**                                                                                         |
| **Authorization**        | `@trustos/authorization` — `@Authorize`, and the engine's own `authorizer.assert`      | None                                                                     | **No**                                                                                         |
| **Policy**               | `@trustos/policy-engine` + `@trustos/workflow-policy`, invoked inside `transition`     | Projects `policyDecisionId` onto the decision view                       | **No**                                                                                         |
| **Workflow**             | `@trustos/workflow-runtime` — `WorkflowEngine.transition`, `available`, `find`, `list` | None. The only mutation available is `transition`                        | **No**                                                                                         |
| **Maker-checker**        | `@trustos/workflow-approvals` — eligibility and self-approval, enforced in the engine  | None                                                                     | **No**                                                                                         |
| **Tasks & eligibility**  | `@trustos/workflow-tasks` — `listAvailable`, `listMine`, `find`, `reassign`            | None. Eligibility is resolved server-side from roles and groups          | **No**                                                                                         |
| **Audit**                | `@trustos/audit` — `AuditService.query`, written by `HistoryRecorder`                  | Projects records into a timeline. Read-only                              | **No**                                                                                         |
| **Concurrency**          | The engine's `expectedVersion` optimistic lock                                         | Makes `expectedVersion` **required** on a human submission               | **No** — a stricter use of the existing mechanism                                              |
| **Idempotency**          | `@trustos/workflow-runtime` `runIdempotent`                                            | Passes the client's key through                                          | **No**                                                                                         |
| **Correlation**          | Request ids and `correlationId` through the existing structured logger                 | Surfaces the instance and business-object ids on the detail view         | **No**                                                                                         |
| **Approval view safety** | `@trustos/governance-workflow-bridge` — view staleness, capabilities                   | None                                                                     | **No**                                                                                         |
| **Queue read model**     | —                                                                                      | `ApprovalQueueRow`: joins task to instance, plus filter, search and sort | **New, and deliberately so**                                                                   |

## The one thing that is genuinely new

A queue row. A task knows it is due Tuesday; a workflow instance knows it is an access
change request raised by Ada. Neither knows both, and a reviewer choosing what to open
next needs both on one line.

That join is an application concern. Pushing it into `workflow-tasks` would put a
presentation shape into a domain package to serve exactly one caller, and the next
application would need a different one.

## What the application deliberately does not do

- It holds no store handle. The ports expose no way to write an instance, set a state or
  create a decision, so no future edit can bypass authorization, policy, maker-checker,
  decision recording or audit by reaching past the engine.
- It does not pre-check permission and then submit. That is a race, and the code trusting
  the first answer would be the code recording the decision.
- It does not read role names to decide what a person may do. `eligibleActions` comes
  from `engine.available` and draws buttons; it never gates a submission.

## Filtering, stated honestly

Search, type, priority, state and SLA filters are applied to the page the store returned,
not pushed into the query. So `total` counts what the tenant-scoped store matched, not
what survived the filter. Pushing predicates into `TaskListQuery` is the right eventual
answer; presenting a filtered count as a total would be a wrong answer now.
