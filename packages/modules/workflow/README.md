# @trustos/module-workflow

**Workflow** · v0.1.0 · experimental · owned by TrustOS Platform Engineering

Approval workflows with task assignment, append-only approval history, SLA tracking and escalation hooks. Includes a maker-checker definition.

```bash
trustos add-module workflow --path ../my-app --framework-path .
```

Approval workflows with task assignment, append-only approval history, SLA tracking
and escalation hooks. The maker-checker pattern is included, because it is the shape
almost every regulated workflow starts from.

```ts
await workflows.registerDefinition(
  makerCheckerDefinition({
    key: 'payout.approval',
    name: 'Payout approval',
    checkerPermission: 'payments.payout.approve',
  }),
  organizationId,
);

const { instance, task } = await workflows.start(
  { definitionKey: 'payout.approval', subjectType: 'Payout', subjectId: payout.id },
  organizationId,
  actor.userId,
);

// The submitter cannot approve this. A different holder of the permission can.
await workflows.approve(task.id, organizationId, checker.userId, checker.permissions);
```

## Separation of duties

The submitter of a request cannot approve it, and cannot reject it either —
withdrawal is `cancel`, and a self-rejection would read as an independent decision in
the trail. A step may permit self-approval explicitly, and doing so on a
maker-checker step would leave the audit trail claiming a review that did not happen.

An attempted self-approval is **audited before it is refused**. That is precisely
what a reviewer wants to see, and a silent 403 leaves no trace of the attempt.

Required approvals count **distinct actors**, taken from the append-only history.
Counting decisions would let one person approve twice and satisfy a two-approver
step.

## Assignment is by permission

A task names the permission an approver must hold, not a user id. A workflow that
names individuals stops working the first time someone leaves, and the framework
already has a permission system that knows who holds what. `tasksFor` returns only
tasks the caller could act on — a task list showing work someone cannot do discloses
what is in flight elsewhere in the organization.

## SLA and escalation

Each step has an SLA; a breach is recorded and an `EscalationHook` runs. The hook is
a port because escalation means "page the duty manager" in one product and "email the
approver's manager" in another. The default records breaches and delivers nothing,
and says so at start-up — an SLA that breaches and notifies nobody looks like a
working control.

A task escalates once: `escalatedAt` is set before the hook runs, because a
notification storm is a worse failure than a missed escalation, and the missed one is
visible in the audit trail.

There is no timer. `runEscalations` is called by whatever the application uses as a
scheduler.

## Permissions

| Key                          | Description                                | Suggested roles                                      |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `workflow.definition.read`   | View workflow definitions.                 | organization_owner, administrator, operator, auditor |
| `workflow.definition.manage` | Register or retire a workflow definition.  | organization_owner                                   |
| `workflow.instance.read`     | View workflow instances and their history. | organization_owner, administrator, operator, auditor |
| `workflow.instance.start`    | Start a workflow instance.                 | organization_owner, administrator, operator          |
| `workflow.instance.cancel`   | Cancel a running workflow instance.        | organization_owner, administrator                    |
| `workflow.task.read`         | View assigned approval tasks.              | organization_owner, administrator, operator, auditor |
| `workflow.task.act`          | Approve or reject an assigned task.        | organization_owner, administrator                    |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                                  | Permission                   |
| -------------------------------------- | ---------------------------- |
| `GET /workflows/definitions`           | `workflow.definition.read`   |
| `POST /workflows/definitions`          | `workflow.definition.manage` |
| `GET /workflows/instances`             | `workflow.instance.read`     |
| `POST /workflows/instances`            | `workflow.instance.start`    |
| `GET /workflows/instances/:id`         | `workflow.instance.read`     |
| `GET /workflows/instances/:id/history` | `workflow.instance.read`     |
| `POST /workflows/instances/:id/cancel` | `workflow.instance.cancel`   |
| `GET /workflows/tasks`                 | `workflow.task.read`         |
| `POST /workflows/tasks/:id/approve`    | `workflow.task.act`          |
| `POST /workflows/tasks/:id/reject`     | `workflow.task.act`          |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable           | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `WORKFLOW_DEFAULT_SLA_MINUTES` | SLA applied to an approval step that does not declare one. |

### Feature flags

- `workflow.escalation` (default on) — Run escalation hooks when a task breaches its SLA.

## Database

- `prisma/schema/23-workflow.prisma` — WorkflowDefinition, WorkflowInstance, WorkflowTask and WorkflowHistoryEntry tables.

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port             | Purpose                                                                                     | Ships                     |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| `EscalationHook` | Runs when a task breaches its SLA. Wire it to the notification module, a pager, or nothing. | `RecordingEscalationHook` |
| `WorkflowStore`  | Where definitions, instances, tasks and history live.                                       | `PrismaWorkflowStore`     |

## Depends on

None.

## Out of scope

- BPMN or a visual designer
- Parallel and conditional branching
- Timers driven by an external scheduler — call `runEscalations` yourself
- Delegation and out-of-office reassignment

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/workflow
```

Unit, tenant isolation, RBAC where this module makes its own authorization decisions,
configuration validation and lifecycle. Isolation tests drive the Prisma store over
`FakeModelDelegate`, so they exercise `@trustos/tenancy` rather than a test double.

## Changes

### 0.1.0

Initial release.

## See also

- `AGENTS.md` — the invariants in this module that must not be weakened
- `docs/modules.md` — the module system
- `docs/module-development.md` — writing one
- `docs/module-versioning.md` — what counts as a breaking change
