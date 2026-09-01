# @trustsystem/cli

The `trustos` command. Generates production-ready TrustOS applications from the
approved templates in this repository.

```bash
trustos new merchant
```

Full documentation: [`docs/cli.md`](../../docs/cli.md).

---

## Quick reference

| Command                          | What it does                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| `trustos new <template>`         | Create a new application                                     |
| `trustos list-templates`         | List the approved templates                                  |
| `trustos validate-template [id]` | Check a template against the generator contract              |
| `trustos doctor`                 | Check this machine can generate and run TrustOS applications |
| `trustos add-module <module>`    | Not implemented in this phase                                |
| `trustos upgrade`                | Not implemented in this phase                                |

| Template            | Entities                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `generic-saas`      | WorkspaceItem                                                           |
| `merchant`          | Merchant, Store, Branch, MerchantMember                                 |
| `learning`          | StudentProfile, LearningSession, QuizAttempt                            |
| `payment-gateway`   | MerchantAccount, ApiKey, Payment, PaymentStatusHistory, WebhookEndpoint |
| `telegram-mini-app` | Task, TelegramProfile                                                   |

---

## Installation

The framework packages are not published yet, so the CLI runs from a checkout:

```bash
npm install
npm run build:packages
npm link -w @trustsystem/cli     # or: node packages/cli/bin/trustos.js

trustos new merchant --framework-path /path/to/trustos-framework
```

`--framework-path` rewrites the generated `@trustsystem/*` dependencies to `file:`
links so the new project installs and builds immediately. It becomes
unnecessary once the packages are published.

Requires Node 20.11+ and npm 10+.

---

## What it will not do

- Fetch a template from the internet. Templates are local and version-controlled.
- Run a script a template asked it to run. There is no such mechanism.
- Write outside the project directory. Ever.
- Create a `.env`, or any key material.
- Overwrite an existing file without `--force`.
- Leave a half-generated project behind if something fails.

The reasoning behind each is in
[`docs/generator-security.md`](../../docs/generator-security.md).

---

## Contributing

- Template design rules and the approval matrix:
  [`docs/templates.md`](../../docs/templates.md)
- Release process and version history: [`CHANGELOG.md`](CHANGELOG.md)

Before opening a pull request:

```bash
npm run lint && npm run typecheck && npm test
node packages/cli/bin/trustos.js validate-template --all
```
