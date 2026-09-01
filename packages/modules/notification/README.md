# @trustsystem/module-notification

**Notification** · v0.1.0 · experimental · owned by TrustOS Platform Engineering

Templated messages over email, Telegram and webhooks, with per-tenant channel configuration, a retry queue and full delivery history. Mock adapters only.

```bash
trustos add-module notification --path ../my-app --framework-path .
```

Templated messages over email, Telegram and webhooks. Everything except the last hop
is real: the template engine, the delivery state machine, the retry queue with
exponential backoff, the per-organization channel configuration, the full attempt
history and the audit trail. The channels themselves are mocks.

```ts
await notifications.createTemplate(
  {
    key: 'welcome',
    name: 'Welcome',
    channel: 'email',
    subject: 'Welcome, {{name}}',
    body: 'Hello {{name}}.',
    variables: ['name'],
  },
  organizationId,
);

await notifications.send(
  {
    templateKey: 'welcome',
    channel: 'email',
    target: 'ada@example.com',
    variables: { name: 'Ada' },
  },
  organizationId,
);
```

## The template engine is not a template language

A message template is authored through the API, which makes it untrusted input, and
compiling untrusted input with Handlebars, Nunjucks or EJS is server-side template
injection — all three expose enough of the runtime from inside a template to read the
environment or execute code.

So substitution is literal and total: `{{name}}` is replaced by a declared variable,
nothing else is interpreted, an undeclared placeholder is a validation error when the
template is _saved_, and substitution is single-pass so a value containing
`{{other}}` cannot expand further. `\{{` renders a literal `{{`.

The cost is that a template cannot format a date or pluralise a noun. That belongs to
the caller, which has types and a test suite.

## Delivery

`PENDING → SENT | FAILED`, `FAILED → PENDING | DEAD`. Terminal states have no
outgoing transitions. `FAILED` means "will be retried"; `DEAD` means "we stopped
trying", and conflating them hides the second case.

Whether a failure is retryable comes from the channel, because only the transport
knows whether "could not deliver" means "not yet" or "not ever". Backoff is
exponential from 30s, capped at an hour, and deterministic — jitter belongs in a
queue with competing workers, and would make every retry test irreproducible.

The queue is a port. `InMemoryRetryQueue` is process-local and is not a production
queue; implement `RetryQueue` over your own infrastructure for durability.

## Real providers

Implement `NotificationChannel` and pass it in the channel map. The mock adapters
fail deterministically on recognisable inputs — `*.invalid` is permanently
undeliverable, `@throttled.example` reports a transient rate limit — so a test can
ask for a failure and get one.

The webhook mock makes no network call but validates the URL as a real client must:
https only, and no loopback or private address. A webhook aimed at `169.254.169.254`
is a metadata-service read from inside the cluster. Literal addresses only — a
hostname that resolves to a private address is not caught here and cannot be without
resolving it, so a real client must re-check after resolution.

## Permissions

| Key                            | Description                                                    | Suggested roles                                      |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- |
| `notification.message.read`    | View messages and their delivery status.                       | organization_owner, administrator, operator, auditor |
| `notification.message.send`    | Send a message and retry a failed one.                         | organization_owner, administrator                    |
| `notification.template.read`   | View message templates.                                        | organization_owner, administrator, operator, auditor |
| `notification.template.manage` | Create, change or retire a message template.                   | organization_owner, administrator                    |
| `notification.settings.read`   | View this organization channel settings.                       | organization_owner, administrator, operator, auditor |
| `notification.settings.manage` | Change this organization channel settings and sender identity. | organization_owner                                   |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                                    | Permission                     |
| ---------------------------------------- | ------------------------------ |
| `GET /notifications/messages`            | `notification.message.read`    |
| `GET /notifications/messages/:id`        | `notification.message.read`    |
| `POST /notifications/messages`           | `notification.message.send`    |
| `POST /notifications/messages/:id/retry` | `notification.message.send`    |
| `GET /notifications/templates`           | `notification.template.read`   |
| `POST /notifications/templates`          | `notification.template.manage` |
| `PUT /notifications/templates/:id`       | `notification.template.manage` |
| `DELETE /notifications/templates/:id`    | `notification.template.manage` |
| `GET /notifications/settings`            | `notification.settings.read`   |
| `PUT /notifications/settings`            | `notification.settings.manage` |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `NOTIFICATION_DEFAULT_SENDER`     | Sender identity used when an organization has not set one. |
| `NOTIFICATION_MAX_ATTEMPTS`       | Delivery attempts before a message is dead-lettered.       |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | Timeout applied to a webhook delivery attempt.             |

### Feature flags

- `notification.channel.email` (default on) — Deliver messages addressed to the email channel.
- `notification.channel.telegram` (default off) — Deliver messages addressed to the Telegram channel.
- `notification.channel.webhook` (default off) — Deliver messages addressed to the webhook channel.

## Database

- `prisma/schema/21-notification.prisma` — NotificationTemplate, NotificationMessage and NotificationAttempt tables.

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port                  | Purpose                                                                                                                  | Ships                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `NotificationChannel` | One transport. Replace a mock adapter with a real provider without touching the queue, the templates or the audit trail. | `MockEmailChannel`, `MockTelegramChannel`, `MockWebhookChannel` |
| `RetryQueue`          | Where pending deliveries wait. The in-memory implementation is process-local and is not a production queue.              | `InMemoryRetryQueue`                                            |
| `NotificationStore`   | Where templates, messages and attempts live.                                                                             | `PrismaNotificationStore`                                       |

## Depends on

None.

## Out of scope

- Real email providers (SMTP, SES, SendGrid) — implement `NotificationChannel`
- Real Telegram Bot API calls — same port
- Redis or Kafka backed queues — implement `RetryQueue`
- Scheduled digests and batching
- Inbound message handling

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/notification
```

Unit, tenant isolation, RBAC where this module makes its own authorization decisions,
configuration validation and lifecycle. Isolation tests drive the Prisma store over
`FakeModelDelegate`, so they exercise `@trustsystem/tenancy` rather than a test double.

## Changes

### 0.1.0

Initial release.

## See also

- `AGENTS.md` — the invariants in this module that must not be weakened
- `docs/modules.md` — the module system
- `docs/module-development.md` — writing one
- `docs/module-versioning.md` — what counts as a breaking change
