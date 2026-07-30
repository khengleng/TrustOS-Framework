# AGENTS.md — rules for AI coding agents in this repository

This file governs automated changes to the TrustOS Engineering Framework itself.
Generated applications get their own `AGENTS.md` from `templates/_base`; the
product-level guidance lives in [docs/ai-agent-instructions.md](docs/ai-agent-instructions.md)
and the standards in [docs/coding-standards.md](docs/coding-standards.md) and
[docs/security-standards.md](docs/security-standards.md).

Read this before changing anything under `packages/identity`, `packages/authorization`,
`packages/api-keys`, `packages/service-accounts`, `packages/session-security`,
`packages/security-events`, `packages/security-policy`, `packages/security-testing`, any
`packages/workflow-*` or `packages/case-management`.

---

## The thirteen rules

Every rule below describes a change that **compiles, passes an unmodified test suite,
and silently removes a security control**. That is why they are stated as rules rather
than left to review: none of them is caught by a type checker, and several were caught
here only by a test written specifically to catch them.

### 1. Never bypass identity validation

There is one way an actor comes into existence: `AuthenticationGuard` resolves exactly
one `CredentialAuthenticator`, which verifies a credential and returns an
`ActorContext`. No route reads a user id from a header, a query parameter or a body
field. No test helper that fabricates an actor may be exported from a non-test entry
point.

### 2. Never decode a token without verifying its signature

`jwtDecode`, `JSON.parse(atob(...))` and `jose.decodeJwt` are not authentication. If a
claim influences a decision, the token must have been verified first — signature,
algorithm, issuer, audience, expiry. `packages/security-testing` provides
`algNoneToken`, `signedByAnotherKey` and `tamperedPayload` precisely so that a new
provider proves it refuses them.

### 3. Always validate the issuer and the audience

A correctly signed token from a different issuer is somebody else's token. A token
whose `aud` names a different client was minted for a different application, and
accepting it makes this application a confused deputy. Both are required in production
and `productionPolicyProblems` refuses a configuration that omits either.

### 4. Never trust client-supplied roles

Roles and permissions are resolved on the server, per request, from the membership
tables. A provider that copies `realm_access.roles` straight into `ActorContext.roles`
without mapping and without a server-side membership check has made the token the
authorization decision. `OidcIdentityProvider.mapRoles` uses an explicit map and
reports what it could not map.

### 5. Never trust client-supplied organization scope

The organization comes from the verified actor and the server-side membership lookup.
An `X-Organization-Id` header naming an organization is a request, not a fact.
`TenantGuard` and `tenantMembershipPolicy` both check it, and
`packages/authorization` has explicit tests for header manipulation, inactive
membership and invitation-token reuse.

### 6. Default authorization decisions to deny

`authorize()` returns deny unless a policy explicitly allows. A new policy that cannot
form an opinion returns "no opinion", which means deny. Never write a policy that
allows on an unknown case, and never reorder the policy list so that something other
than `rbac.permission` gets the last word.

### 7. Never store plaintext API keys

Only `keyPrefix`, `keyHash` and metadata are persisted. The plaintext exists for the
lifetime of one response — `create` and `rotate` — and no other code path can produce
it, because no code path has it. Do not add a "reveal key" endpoint; there is nothing
to reveal.

### 8. Never log tokens or credentials

Not at debug level, not temporarily, not while investigating an incident. Log the
prefix (`tos_live_abcd…`) or `correlationHash(value, salt)`. `redactSecrets` strips
secret-named fields, but it is a safety net and not a licence: a field named
`data` holding a token is not caught by any name-based redactor.

### 9. Preserve refresh-token reuse detection

A used refresh token presented a second time revokes the whole rotation family and
emits `session.refresh_reuse_detected` at critical severity. This is the only signal
the framework has that a refresh token was stolen. `usedAt` and `revokedAt` are
separate columns for this reason; collapsing them turns a theft into an ordinary
rejection and leaves the thief's session alive.

### 10. Add negative security tests

A test that a valid token works proves nothing about a tampered one. Every credential
path needs tests that the wrong input is refused — and refused _identically_, so the
error does not distinguish "no such account" from "wrong password" from "locked".
`SECURITY_TEST_CATEGORIES` in `@trustos/security-testing` lists the categories a new
credential type is expected to cover.

### 11. Document new permissions and scopes

Add the key to `PERMISSIONS` in `packages/rbac/src/permissions.ts` with a description,
and grant it to the roles that should hold it, before using it. Never rename or
repurpose an existing key: a renamed key silently grants or revokes access on every
deployment that has not been migrated.

### 12. Audit all privileged operations

Credential creation, revocation and rotation; role and permission changes; session
revocation; service-account lifecycle. `AuditService` for what a customer must be able
to reconstruct, `SecurityEventEmitter` for what was attempted and refused. The two are
different trails with different audiences — see
[docs/security-testing.md](docs/security-testing.md).

### 13. Stop after the approved scope is complete

Do not add infrastructure, providers or integrations that were not asked for. In
particular this phase deliberately contains no Redis, no external secrets manager, no
custom OTP system, no SMS delivery and no cloud storage. Where one of those would go,
there is a documented port. Extend the port; do not add the dependency.

---

## The fourteen workflow rules

Same standard as the thirteen above: every one describes a change that **compiles, passes an
unmodified test suite, and silently removes a control**.

### 1. Never bypass workflow state validation

Every state change goes through `resolveTransition` and an action the definition declares. There is
no route that writes `currentState`, and adding one would make the definition advisory — a second
implementation of the workflow that disagrees with the first within a month.

### 2. Never modify a published workflow definition

Not its states, not its approvers, not a typo in a description. A running instance reads its rules
from that row, so editing it retroactively changes the rules a decision was made under. A change is
a new version. Three layers already refuse it — the service, the runtime's hash check, and a
database trigger — and defeating any of them is defeating all three.

### 3. Never allow self-approval where maker-checker is enabled

`allowSelfApproval` defaults false and `selfApprovalPolicy` enforces it. Do not add a code path that
skips the policy, do not read the submitter from a request body, and do not "temporarily" set the
flag while debugging. A workflow whose submitter can approve their own request is not a control; it
is a log entry that looks like one.

### 4. Never trust client-supplied workflow state

Not `currentState`, not `initiatedById`, not approval progress, not task ownership, not a comment
visibility filter. Every one comes from a row the server read. `WorkflowActor` deliberately has no
field for any of them, and adding one is how the whole engine becomes decorative.

### 5. Always enforce tenant isolation

The organization comes from the verified actor. A record in another organization is `notFound`,
never `forbidden` — a 403 confirms the record exists, which is the enumeration primitive the
boundary exists to deny. Every new tenant-owned index leads with `organizationId`.

### 6. Always use authorization policy decisions

Do not write an `if` in a service where a policy belongs. A check in a service covers one call path;
a policy covers every route that declares the action, including ones written later. Build the
resource with `workflowResource()` — a policy that cannot find its field abstains, and an abstaining
separation-of-duty policy is a control that silently does not run.

### 7. Always record audit history

Every transition, decision, assignment, reassignment, escalation and case change. Through
`HistoryRecorder.record`, which writes history _and_ the audit trail in one call — because a caller
who writes one and forgets the other produces a complete history and an audit trail with a hole in
it, discovered during an audit rather than in a test.

### 8. Always add negative tests

A test that a valid transition works proves nothing about an illegal one. Every new action needs
tests that the wrong actor, the wrong state, the stale version and the duplicate submission are all
refused — and refused with the _right_ reason, because a client that cannot tell a conflict from a
denial retries the wrong one.

### 9. Preserve idempotency

An externally triggered action accepts an idempotency key, hashes the payload, and refuses the same
key with a different payload. Never replay the first result for a different payload: that tells the
caller an operation succeeded that never ran for their request, which is worse than any error.

### 10. Preserve concurrency controls

Every write is conditional on the version the read saw. `TaskStore.claim` is atomic in the store,
not in the service — a check-then-act split across two calls cannot be made safe by anything the
service does. Zero rows updated is the signal that somebody else won; turning it into a retry would
produce the duplicate this exists to prevent.

### 11. Do not delete workflow history

`HistoryStore` has no update and no delete, and the database refuses both. A comment is amended by
writing its previous text; a comment is redacted by hiding it, never by deleting it. The usual reason
to redact is that a comment contains something it should not, which is exactly when the original
must remain available to whoever is investigating.

### 12. Document every new action and permission

Add the permission to `WORKFLOW_PERMISSIONS` with a description and grant it to the roles that
should hold it, before using it. If it is approval-shaped, register it with
`registerApprovalAction` so the self-approval and duplicate-approval policies cover it. Never rename
an existing key.

### 13. Do not add product-specific workflows without approval

The framework ships two generic examples. A merchant onboarding workflow, a loan origination
workflow or a payment release workflow belongs in a product, not here — and a framework example that
encoded one industry's rules would be copied by everyone who does something slightly different.

### 14. Stop after the approved scope is complete

No BPMN, no Camunda, no Temporal, no visual designer, no AI workflow generation, no Kafka, no
Kubernetes. Where one of those would go there is a documented port or a stated limitation. Extend
the port; do not add the dependency.

If a change requires breaking one of these, stop and ask. Do not work around it.

---

## Guard order is the security model

`apps/security-admin-example/src/security-admin.module.ts` registers seven global
guards. Nest applies them in registration order:

```
AuthenticationGuard           who is calling?              -> request.actor
TenantGuard                   whose data may they see?     -> request.organizationId
InteractiveRouteGuard         is this route for a person?
AuthenticationAssuranceGuard  did they prove it strongly enough?
PermissionsGuard              may they do this at all?     (deny by default)
ScopeGuard                    may this credential do it?
PolicyAuthorizationGuard      does the full policy set allow it?
```

Each one can only refuse. Reordering them is a security review, not a refactor — in
particular, assurance runs before permissions so that a privileged role with no second
factor is stopped before its permissions are consulted. `security-admin.spec.ts`
asserts this order against the running injector, so a reordering fails a test rather
than passing quietly.

## Workflow-specific checks

A change to a definition, or to the validator, additionally needs:

```bash
# Structural validation, and permission references against the catalog.
node packages/cli/bin/trustos.js workflow validate <file> --strict-permissions

# Every path. Non-zero if any reaches a success outcome with no approval at all.
node packages/cli/bin/trustos.js workflow simulate <file>
```

The second is the check worth running before every commit that touches a definition. A path to
`approved` with no review is invisible on inspection of a forty-state document and obvious to a
graph walk, and it is almost always a shortcut transition added for testing and left in.

## Integration rules (phase 6)

The integration layer is where this platform meets everything outside it. These rules are the ones
whose violation is _silent_ — no error, no log line, and a symptom weeks later.

1. **Reuse the framework packages. Never duplicate one.** There is one retry implementation, one
   event envelope, one circuit breaker. A second one is a second set of defaults, and the two
   diverge within a month. If something is missing, extend the package rather than writing a local
   version.

2. **Always validate the tenant.** Every store method takes `organizationId` explicitly, and it is
   `string | null` rather than optional so a caller cannot omit it. A method with no tenant
   parameter is a query that returns every organization's rows.

3. **Always validate the signature.** Every inbound webhook, every time, against the raw bytes
   received — not a re-serialized body. Constant-time comparison. A signature check that returns
   early on a mismatch leaks through timing.

4. **Always record an audit entry** for anything an operator does: a replay, a rotation, a
   cancellation, a resume. Hints and identifiers, never secret values.

5. **Always add tests, including the negative and the concurrent one.** A guarantee with no test
   that it holds under two callers is a comment. Every constraint in this phase — duplicate
   suppression, lease loss, tenant scope — has a test that exercises the race.

6. **Never bypass a retry policy.** No hand-rolled `for` loop with a `setTimeout`. `withRetry`
   applies jitter, and without jitter every client that failed together retries together — which is
   how a partial outage becomes a total one.

7. **Never bypass event validation.** An event whose schema is not registered is never published.
   Do not add a "raw publish" path; the registry is what makes the bus a contract rather than a
   place where anything can appear.

8. **Never expose a secret.** Not in an event, a log, an audit record, an error message, a webhook
   body or a health response — not even truncated. A secret is shown once, at creation.

9. **Never ship a provider implementation in the framework.** The seam is the deliverable. An
   adapter belongs to the product built on this, and one in the framework is one every product
   carries.

10. **A store contract that says "must be atomic" means it.** `claimDue`, `claim`, `enqueue` and
    the idempotency insert are single statements with `FOR UPDATE SKIP LOCKED` or a unique
    constraint. A read-then-write implementation passes every single-threaded test and double-sends
    the moment a second worker starts.

11. **Bound everything that crosses a boundary.** Rows, columns, cells, bytes, response bodies,
    recursion depth. An unbounded parse is an out-of-memory crash an authenticated user can trigger
    at will.

12. **Escape a cell before it reaches a spreadsheet.** A value beginning `=`, `+`, `-` or `@` is a
    formula that executes when the file is opened, and the value came from a user.

Read [docs/integration-security.md](docs/integration-security.md) before changing anything in
`webhook-runtime/destination.ts`, `webhooks/signature.ts` or `export/formats.ts`. The checks in
those files look redundant and are not.

## AI rules (phase 7)

The AI layer is where this platform lets a probabilistic system take actions. Every rule below
describes a change that compiles, passes the tests, and removes a control that only announces
itself when something has already gone wrong.

1. **Reuse the framework packages. Never duplicate one.** There is one gateway, one guardrail
   pipeline, one token meter, one cache-key builder. A second one is a second set of defaults, and
   the two diverge within a month.

2. **Never bypass the gateway.** No provider SDK imported outside an adapter, no direct HTTP call
   to a model endpoint. The gateway is where policy, guardrails, routing, cost accounting and audit
   are applied, and a request that goes around it is a request nobody can account for afterwards.

3. **Never bypass guardrails.** Do not add a `skipGuardrails` flag, a "trusted caller" path or an
   internal-only bypass. A caller who needs different thresholds configures a guardrail profile.
   The moment a bypass exists, every other guarantee in this phase becomes conditional on nobody
   using it.

4. **Never expose secrets.** Provider credentials live in the environment and are redacted
   structurally — `[SET]` or `[NOT SET]`, never a prefix. Nothing in the AI schema has a column for
   a credential, and nothing should gain one. A prompt is not a secret either: assume a determined
   user extracts the system prompt, and put nothing in it that matters if they do.

5. **Never bypass tenant isolation.** Every store call takes `organizationId` explicitly. A cache
   key is built from a context, never from a string a caller assembles. Null is the platform
   tenant, not a wildcard. The failure here is silent: the wrong tenant's answer is a perfectly
   good answer.

6. **Always audit AI actions.** Every request, every tool call, every review decision, every prompt
   publication, every policy change. Metadata, prompt version, tool names and outcomes — never the
   prompt, the completion or the conversation. Where content lives is one deliberate place.

7. **Always validate tool permissions against the _actor_, not the agent.** This is the control
   that makes a successful prompt injection survivable, and it is the one most easily "simplified"
   away by someone who reads the agent's tool list as a grant rather than a ceiling. Never accept
   `organizationId` as a tool parameter.

8. **Always validate prompt versions.** Render through the registry, check the content hash, and
   never edit a published version. An inline production prompt has no author, no approval and no
   rollback.

9. **Always use the model registry.** No model name in application code. A hardcoded model cannot
   be retired centrally and cannot fall back when its provider has an incident.

10. **Always use the prompt registry** for anything a customer reads. Three people — author,
    approver, publisher — and the framework refuses self-approval and self-publication.

11. **Never claim to eliminate hallucination.** Guardrails reduce a rate; retrieval reduces it
    further; neither eliminates it. Any comment, log line, doc or metric name implying otherwise is
    wrong and will be believed. Name a heuristic a heuristic: `groundedness` measures word overlap,
    and its own `detail` string says so because the number gets copied into dashboards.

12. **Never cache a sensitive request** unless the tenant policy explicitly allows it. Caching is
    off by default, and `confidential` collections are never cached.

13. **A limit reached is not a success.** A run that exhausted its steps, tokens or time reports
    `limit_reached`, and a truncated completion is not a final answer. Presenting half a thought as
    a conclusion is the failure mode of every agent framework that gets this wrong.

14. **Always add tests, including the negative one.** Every agent deserves four: the injection
    test, the limit test, the tool-failure test, and — where it requires review — the test that its
    output cannot be read until a person approves it.

15. **Stop after completing phase 7.** Do not begin phase 8. Do not add business-specific agents,
    a chat interface, voice, image generation, fine-tuning or a marketplace. Phase 7 is a reusable
    enterprise AI platform, and every product-specific thing added to it is carried by every
    product built on it.

Read [docs/ai-security.md](docs/ai-security.md) before changing anything in
`tool-execution/executor.ts`, `ai-cache/cache.ts`, `prompt-registry/template.ts` or
`agent-memory/memory.ts`. The checks in those files look redundant and are not.

## Financial rules (phase 8)

Money is the one thing in this repository where being subtly wrong is worse than being obviously
broken. A crash gets fixed on the day; a fee that is wrong in the fifteenth decimal place is found
by a counterparty six months later, and by then it is in ten thousand transactions.

1. **Never modify a posted journal.** No `UPDATE`, no `DELETE`, no "just fix the description". A
   correction is a reversal or an adjustment, both of which post a _new_ journal and leave the
   original standing. The database refuses it too, by trigger — if you find yourself wanting to
   drop that trigger, the change is wrong.

2. **Never use floating-point arithmetic for money.** No `parseFloat`, no `Number(amount)`, no
   `Float` column, no arithmetic on a JSON number that came from an amount. Use `Decimal` and
   `Money` from `@trustos/financial-core`. The single `unsafeToNumber` is named to be uncomfortable
   and belongs only in a display layer that never feeds a calculation.

3. **Always validate balancing.** Debits equal credits, per currency, before anything posts. Never
   net across currencies inside one journal — an exchange goes through an FX account with its own
   two entries, because netting hides the rate that was used.

4. **Always enforce idempotency.** Every operation that moves money takes a key, and the store
   enforces it with a _unique constraint_. A read-then-write check passes every single-threaded
   test and posts twice the moment two workers retry together. Scope the key to the tenant, with
   `COALESCE` on the organization — PostgreSQL treats NULL as distinct from NULL.

5. **Always audit financial actions.** Every posting with its accounts and amounts, every reversal
   with its reason, every status change, every limit refusal, every reconciliation resolution. An
   auditor asks what moved and who decided; both must be answerable from the record alone.

6. **Never bypass limits.** No "internal caller" path, no flag that skips the limit engine.
   `check` is a read and `consume` is the reservation — a caller that checks and then posts without
   consuming has reintroduced the race the two-method split exists to close.

7. **Never bypass tenant isolation.** Every store method takes `organizationId` explicitly, and it
   is `string | null` rather than optional so a caller cannot omit it. Null is the platform tenant,
   not a wildcard.

8. **Check the available balance, never the total.** A hold is money that is present and not
   spendable. A system that checks the total authorizes the same money twice, and the second
   capture fails at settlement — after the customer has been told both succeeded.

9. **Amounts on entries are positive; the direction carries the sign.** A negative debit and a
   credit are the same movement written two ways, and a ledger that stores both has two
   representations of every posting.

10. **A customer wallet is a liability.** Money a customer deposited is money the business owes.
    Model it as an asset and the platform reports its own obligations as its own money. The same
    care applies to every account class: get one backwards and every balance in it is reported with
    the wrong sign, which looks like a ledger bug and is not.

11. **Never ship a provider, a scheme or a jurisdiction's rules.** No card network, no bank rail,
    no chart of accounts, no KYC rule, no live rate feed. The seam is the deliverable; the
    integration belongs to the product built on this.

12. **Always add financial tests**, including the negative one and the concurrent one. Every
    guarantee in this phase — balancing, immutability, idempotency, the available-balance check,
    allocation summing back exactly — has a test that tries to break it. A guarantee with no test
    that it holds under two callers is a comment.

13. **Stop after completing phase 8.** Do not begin phase 9. Do not add Bakong, KHQR, PayChain,
    payKH, ABA, ACLEDA, Wing, Visa, Mastercard, SWIFT, ISO 20022, blockchain or stablecoin
    support. Phase 8 is a reusable financial foundation, and every product-specific thing added to
    it is carried by every product built on it.

Read [docs/financial-security.md](docs/financial-security.md) before changing anything in
`ledger/ledger.ts`, `financial-core/decimal.ts`, `wallet/service.ts` or the phase 8 section of the
Prisma migration. The checks in those files look redundant and are not.

## Template rules (phase 9)

The industry template library. Thirty templates, one SDK, one registry. Fourteen rules on top of
everything above.

1. **Always reuse framework packages.** Auth, RBAC, tenancy, audit, workflow, ledger, limits and
   `@trustos/template-sdk` already exist. A template that writes its own permission check has
   written a second, worse one, and the two will disagree.

2. **Never duplicate a module.** If two templates need the same thing, it belongs in `_base` or in
   a parent template. The shared mini app shell is in `_base` for exactly this reason — three
   copies of a WebView handshake would be three chances to get the verification wrong.

3. **`templates/` is generated. The source is `scripts/template-specs.mjs`.** Editing a file under
   `templates/` directly is a change the next regeneration discards. Change the spec, then run all
   three sync scripts:
   `scaffold-industry-templates.mjs`, `sync-template-registry.mjs`, `sync-industry-reference.mjs`.

4. **Prefer `extends` to a new standalone template.** A hospital is a clinic plus wards. Copying a
   parent gives two files identical on the day they are written and quietly different a year
   later.

5. **Every product model carries `organizationId`.** A model without it cannot be scoped, so every
   query over it returns every tenant's rows — and nothing fails. `validate-template` refuses it.

6. **No float and no bare `Int` for money.** `Decimal @db.Decimal(28, 8)`, or an integer
   minor-unit column with a `///` comment saying so. Phase 8's rule, checked mechanically here.

7. **Always audit writes.** A change with no audit row is a change nobody can answer questions
   about six months later, and the question always arrives at the worst moment.

8. **Personal data gets its own permission.** Mark the field `pii`. The API projects the column
   away server-side; a column hidden in CSS is still in the payload.

9. **Permission keys are permanent.** Add freely, never rename. A renamed key silently revokes
   access on every deployment that has not been migrated and grants it on none.

10. **Declare every module and its prerequisites.** A manifest naming `wallet` without `ledger`
    generates an application whose wallet cannot compute a balance, and it fails on the first
    request in a project nobody has opened yet.

11. **Always generate documentation.** Every manifest names a `documentation` page and the
    validator checks it exists. A deprecated template names its successor, or the manifest is
    refused.

12. **Always generate tests.** Every template ships a tenant-isolation test.
    `validate-template` fails a template that ships none — tenant leakage is the quietest failure
    a generated application can have.

13. **Always validate compatibility.** `trustos validate-template <id>` before claiming a template
    change works, and `trustos new <id> --framework-path .` before claiming it generates.

14. **Stop after completing phase 9.** Do not begin phase 10. Do not add a business-specific
    integration, a payment provider, a government API, an external AI provider or a cloud vendor
    service to any template. Every one of those is a seam a deployment fills, and a template that
    filled one for everybody is a template only one deployment can use.

Read [docs/template-development-guide.md](docs/template-development-guide.md) before adding or
changing a template, and [docs/template-sdk.md](docs/template-sdk.md) before building a screen.
The rule that catches people out: **the server reads the resource declaration first.** A column
permission, a filter allow-list or a menu entry enforced only in the browser is not enforced.

## Before claiming a change is done

```bash
npm run lint
npm run format:check
npm run build:packages
npm test
npm run migrate:drift -w @trustos/database   # needs a database
npx trustos validate-template --all          # after any template change
```

All of them must pass. **Never claim something works because it compiles.** If a test
fails, say which one and what the output was.
