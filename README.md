# TrustOS Engineering Framework

The reusable engineering foundation for TrustOS products — TrustOS Learn,
TrustOS Merchant, payKH, payChain, dbank, Telegram Mini Apps and the vertical
SaaS platforms that follow.

It provides the things every one of those products needs and none of them should
implement twice: validated configuration, authentication, organization-based
tenant isolation, role-based access control, an append-only audit trail,
structured logging, a single error contract, and health endpoints.

It also ships **`trustos`**, a CLI that generates a complete, tenant-isolated,
audited, deployable application from an approved template in a couple of
minutes.

```bash
trustos new merchant
```

Phases one and two are a modular monolith foundation plus its generator. There
is by design no payments, loyalty, campaigns, notifications, marketplace, AI
agents, Kafka, Kubernetes or microservices.

---

## Quick start

Requires **Node 20.11+** (`.nvmrc` pins 20.19.1), **npm 10+**, and
**PostgreSQL 14+**.

```bash
# 1. Install (also generates the Prisma client via postinstall)
npm install

# 2. Configure
cp packages/config/.env.example .env
#    Development works with the defaults. Edit DATABASE_URL if your
#    PostgreSQL is not at localhost:5432 with user/password trustos/trustos.

# 3. Create the database
createdb trustos_dev

# 4. Build the framework packages (applications import their compiled output)
npm run build:packages

# 5. Apply migrations and seed roles, permissions and demo accounts
npm run db:deploy
npm run db:seed

# 6. Run the API on :3000
npm run dev:api

# 7. In a second terminal, run the admin console on :3001
npm run dev:admin
```

Open <http://localhost:3001> and sign in with a seeded account:

| Account             | Role               | Password           |
| ------------------- | ------------------ | ------------------ |
| `owner@acme.test`   | organization_owner | `TrustOSDemo2026!` |
| `admin@acme.test`   | administrator      | `TrustOSDemo2026!` |
| `auditor@acme.test` | auditor            | `TrustOSDemo2026!` |

Demo accounts are created only when `NODE_ENV` is not `production`.

API docs: <http://localhost:3000/docs> · Health: <http://localhost:3000/health>

---

## Verify the installation

```bash
npm run lint          # eslint, including the package layering rules
npm run typecheck     # builds packages, then type-checks all three apps
npm test              # 180 unit tests, no database required
npm run build         # packages + api + starter + admin
npm run db:validate   # prisma schema validation (no database required)
npm run test:tenancy  # the tenant isolation suite on its own
npm audit --audit-level=high
```

All of these run in CI on every pull request (`.github/workflows/ci.yml`).

---

## Commands

| Command                                   | What it does                                                  |
| ----------------------------------------- | ------------------------------------------------------------- |
| `npm install`                             | Install workspace dependencies and generate the Prisma client |
| `npm run build`                           | Build packages, then every application                        |
| `npm run build:packages`                  | Compile the eleven framework packages (`tsc -b`)              |
| `npm run build:apps`                      | Build the API, the starter template and the admin app         |
| `npm run typecheck`                       | Type-check everything without emitting app output             |
| `npm run lint` / `npm run lint:fix`       | ESLint across the workspace                                   |
| `npm run format` / `npm run format:check` | Prettier                                                      |
| `npm test` / `npm run test:watch`         | Vitest                                                        |
| `npm run test:tenancy`                    | Tenant isolation tests only                                   |
| `npm run db:generate`                     | Regenerate the Prisma client                                  |
| `npm run db:validate`                     | Validate `schema.prisma` (no database needed)                 |
| `npm run db:migrate -- --name x`          | Create and apply a migration in development                   |
| `npm run db:deploy`                       | Apply committed migrations (production/CI)                    |
| `npm run db:seed`                         | Seed permissions, system roles and demo data                  |
| `npm run dev:api`                         | API in watch mode on :3000                                    |
| `npm run dev:admin`                       | Admin console in watch mode on :3001                          |
| `npm run clean`                           | Remove all build output                                       |
| `npm run cli -- <args>`                   | Run the `trustos` CLI from the checkout                       |
| `npm run templates:validate`              | Validate every template (ten checks each)                     |

---

## What is in the box

### Packages

| Package                  | Responsibility                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@trustos/shared-types`  | Types shared by server and browser. No runtime dependencies.                                                                            |
| `@trustos/errors`        | Seven error codes, `ApiError`, and the `{ error, message, requestId }` contract. Browser-safe; NestJS filter at `@trustos/errors/nest`. |
| `@trustos/validation`    | Shared Zod schemas and the single path from untrusted input to a typed value.                                                           |
| `@trustos/config`        | Fail-fast environment validation. The only package that reads `process.env`.                                                            |
| `@trustos/logging`       | Pino with request correlation and two layers of secret redaction.                                                                       |
| `@trustos/database`      | Prisma schema, client lifecycle, soft-delete helpers, migrations, seed.                                                                 |
| `@trustos/auth`          | Email/password, bcrypt, JWT, refresh-token rotation with reuse detection.                                                               |
| `@trustos/rbac`          | Permission catalog, five system roles, deny-by-default route guard.                                                                     |
| `@trustos/tenancy`       | Organization scope: request context, query scoping, tenant guard.                                                                       |
| `@trustos/audit`         | Append-only audit trail with actor, organization, before/after and request metadata.                                                    |
| `@trustos/observability` | `/health`, `/ready`, request timing, metrics and OpenTelemetry-ready seams.                                                             |

### The module system

| Package                    | Responsibility                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@trustos/module-sdk`      | The contract every module implements: metadata, lifecycle, configuration, permissions, audit, health, tenant-scoped persistence |
| `@trustos/module-registry` | The approved module catalog, and the in-memory registry applications discover modules through                                   |

### Modules

Reusable business capabilities, installed with `trustos add-module`.

| Module          | Capability                                                                                                     | Tables | Routes |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| `file-storage`  | Object storage behind a provider port, with checksums, versioning and per-organization key namespaces          | 2      | 6      |
| `notification`  | Templated messages over email, Telegram and webhooks, with a retry queue and delivery history                  | 3      | 10     |
| `document`      | Categorised documents with metadata, version history and soft delete                                           | 3      | 10     |
| `workflow`      | Approval workflows with task assignment, approval history, SLA tracking and escalation. Includes maker-checker | 4      | 10     |
| `reporting`     | Report definitions with filtering, pagination, CSV export and a PDF renderer port                              | 1      | 7      |
| `search`        | Global search across module adapters, with permission filtering and ranking                                    | 0      | 2      |
| `feature-flags` | Boolean flags with percentage rollout, per-subject overrides, environment scoping and expiry                   | 2      | 6      |

Every module is organization-scoped, requires a permission on every route, audits
every mutation, contributes to `GET /ready`, installs with no configuration, and can
be tested without a database. Those are not conventions — `defineModule` throws.

```bash
trustos list-modules --verbose                            # what each one exposes
trustos add-module document --path ../my-app              # installs file-storage too
```

See [`docs/modules.md`](docs/modules.md).

### Applications

- **`apps/api-example`** — NestJS reference API: registration, login, refresh,
  logout, organization creation, member invitation, role assignment, a protected
  tenant-scoped endpoint, and audit retrieval.
- **`apps/admin-example`** — Next.js console: login, organization selection,
  members list, role assignment, audit log, with explicit loading, empty and
  error states.
- **`templates/saas-starter`** — copy this folder to start a new product by
  hand. It wires every framework package and includes an example product module
  with its own permissions, tenant scoping, audit logging and isolation tests.

---

## Generating a new application

Rather than copying the starter by hand, use the CLI:

```bash
npm run build:packages
npm link -w @trustos/cli          # or: node packages/cli/bin/trustos.js

trustos doctor                    # check this machine
trustos list-templates --verbose  # see what is available
trustos new merchant --framework-path "$PWD"
```

| Template            | Entities                                                                | Apps         |
| ------------------- | ----------------------------------------------------------------------- | ------------ |
| `generic-saas`      | WorkspaceItem                                                           | api, admin   |
| `merchant`          | Merchant, Store, Branch, MerchantMember                                 | api, admin   |
| `learning`          | StudentProfile, LearningSession, QuizAttempt                            | api, admin   |
| `payment-gateway`   | MerchantAccount, ApiKey, Payment, PaymentStatusHistory, WebhookEndpoint | api, admin   |
| `telegram-mini-app` | Task, TelegramProfile                                                   | api, miniapp |

Every generated application arrives with the framework already wired — three
global guards, audit logging, health probes — plus its own domain models,
migrations, tenant-isolation tests, `AGENTS.md` for AI agents, `trustos.json`
recording exactly what produced it, and Railway configuration.

`--framework-path` is needed only until the `@trustos/*` packages are published
to npm; it rewrites the generated dependencies to local `file:` links.

The generator will not write outside the project directory, will not create a
`.env`, will not run a script a template asked it to run, and leaves nothing
behind if it fails. See [`docs/generator-security.md`](docs/generator-security.md).

### CLI packages

| Package                      | Responsibility                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| `@trustos/cli`               | The `trustos` command: parsing, prompts, output                        |
| `@trustos/generator-core`    | Path containment, rendering, transactional writes, template validation |
| `@trustos/template-registry` | The typed, validated catalog of approved templates                     |

---

## The security model in one page

Three global guards run in this order, and the order is the model:

```
JwtAuthGuard       who is calling?          → request.actor
TenantGuard        whose data may they see? → request.organizationId
PermissionsGuard   may they do this?        → deny by default
```

- **Deny by default.** A route that declares no `@RequirePermissions`,
  `@RequireRoles`, `@AllowAnyAuthenticated` or `@Public` returns 403. Forgetting
  a decorator produces a broken endpoint in staging, not an open one in
  production.
- **The organization comes from the access token**, never from a request body,
  path or header. A request that names a different organization is refused; one
  that names two is refused as ambiguous.
- **Cross-tenant reads report `not_found`, never `forbidden`** — a 403 would
  confirm the id exists somewhere else.
- **Secrets never reach a response, a log, or the browser.** Production error
  bodies carry no message, stack or class from an unexpected error.
- **Sensitive actions are audited** with actor, organization, before/after,
  request id, IP and user agent — and the audit sink has no update or delete.

Details: [`docs/security-standards.md`](docs/security-standards.md).

---

## Documentation

| Document                                                               | Contents                                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                         | Principles, package responsibilities, dependency rules, request lifecycle, tenant isolation rules, deliberate trade-offs, how to create a new application |
| [`docs/security-standards.md`](docs/security-standards.md)             | Authentication, authorization, tenancy, logging, audit, secrets, and this phase's known limitations                                                       |
| [`docs/coding-standards.md`](docs/coding-standards.md)                 | TypeScript, naming, errors, validation, database access, tests, API compatibility                                                                         |
| [`docs/modules.md`](docs/modules.md)                                   | The module system: what every module guarantees, installing, extension points, what is deliberately absent                                                |
| [`docs/module-development.md`](docs/module-development.md)             | Writing a module, and the rules it must follow                                                                                                            |
| [`docs/module-versioning.md`](docs/module-versioning.md)               | Versions, compatibility, and what counts as a breaking change                                                                                             |
| [`docs/enterprise-identity.md`](docs/enterprise-identity.md)           | The identity abstraction, local and OIDC providers, Keycloak, MFA readiness, production checklist                                                         |
| [`docs/authorization-model.md`](docs/authorization-model.md)           | The four layers, the default-deny policy engine, tenant isolation, scopes, decision records                                                               |
| [`docs/api-key-security.md`](docs/api-key-security.md)                 | Key format, hashed storage, lifecycle, rotation, scopes, IP allowlists                                                                                    |
| [`docs/service-account-security.md`](docs/service-account-security.md) | Machine identities, the two credential modes, why not a human account                                                                                     |
| [`docs/session-security.md`](docs/session-security.md)                 | Token lifetimes, refresh rotation and reuse detection, device revocation, headers, CORS, CSRF, rate limiting                                              |
| [`docs/security-testing.md`](docs/security-testing.md)                 | Negative testing, the toolkit, the two trails, redaction, CI gates, the exception process                                                                 |
| [`docs/threat-model.md`](docs/threat-model.md)                         | Fifteen threats, with controls, residual risk and the future control for each                                                                             |
| [`docs/incident-response.md`](docs/incident-response.md)               | Severity, the first five minutes, where the evidence is, five playbooks, containment commands                                                             |
| [`AGENTS.md`](AGENTS.md)                                               | The thirteen mandatory rules for automated changes to the identity and access layer                                                                       |
| [`docs/ai-agent-instructions.md`](docs/ai-agent-instructions.md)       | How AI coding agents must work in this repository                                                                                                         |
| [`docs/railway-deployment.md`](docs/railway-deployment.md)             | Deploying to Railway, variables, migrations, troubleshooting                                                                                              |

---

## Starting a new TrustOS product

```bash
trustos new generic-saas --framework-path "$PWD"
```

Then replace the generated `modules/product` with your domain, keeping its
shape: a permission on every route, `@OrganizationId()` in the handler, audit on
every mutation, and isolation tests beside the code. The generated `AGENTS.md`
states the same rules for an AI agent working in that repository.

To start from the starter template by hand instead, copy
`templates/saas-starter` — the checklist is in
[`docs/architecture.md`](docs/architecture.md) §8.

---

## Security

Never commit a `.env`, a private key, or a credential of any kind — CI fails the
build if one is tracked. Report a vulnerability privately to the platform team
rather than in a public issue.
