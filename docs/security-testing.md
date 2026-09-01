# Security testing

How the framework proves its controls work, and what to write when you add one.

- [Negative tests, not only successful paths](#negative-tests-not-only-successful-paths)
- [The toolkit](#the-toolkit)
- [The twenty-one categories](#the-twenty-one-categories)
- [Two trails](#two-trails)
- [Redaction](#redaction)
- [Running the suite](#running-the-suite)
- [CI gates](#ci-gates)
- [The exception process](#the-exception-process)
- [Adding a credential type](#adding-a-credential-type)

---

## Negative tests, not only successful paths

A test that a valid token is accepted proves almost nothing. It passes against an
implementation that accepts _every_ token, which is the exact bug you are trying not to
ship.

So the identity tests are mostly refusals. `packages/identity/src/oidc/oidc-provider.spec.ts`
has 26 of them, and each one is a token that is almost right:

- signed by a key the issuer does not publish
- `alg: none`
- `alg: HS256` signed with the public key as the secret
- payload tampered after signing
- wrong `iss`
- wrong `aud`
- `azp` naming a different client
- expired, and expired inside the skew window
- not yet valid
- no `sub`

The last one caught a bug in the test helper: `signTestToken` always set `sub`, so
"token with no subject" asserted nothing — `tamperedPayload(token, {})` re-encodes to
identical bytes and still verifies. `omitSubject` exists because of that.

## The toolkit

`@trustsystem/security-testing` exists so that these tests are cheap enough to actually
write.

**Token forgery.** `createTestIdentityKeys` generates an RSA pair and a JWKS.
`signTestToken` signs a valid token; the rest produce specific failures:

```ts
const { keys, jwks } = await createTestIdentityKeys();
const good = await signTestToken(keys, { iss, aud, sub: 'user_1' });

await algNoneToken({ iss, aud }); // unsigned
await signedByAnotherKey({ iss, aud }); // wrong signer
tamperedPayload(good, { sub: 'user_2' }); // modified after signing
wrongIssuer(keys, { aud });
wrongAudience(keys, { iss });
expiredToken(keys, { iss, aud });
notYetValidToken(keys, { iss, aud });
```

**Leak assertions.** These are the ones worth adopting elsewhere:

```ts
assertNoLeakedValues(response, [theActualSecret], 'the response');
assertSecretFieldsRedacted(event, 'the event');
```

`assertNoLeakedValues` searches the serialized structure for the **value**, not for a
field name. That is the difference between a test that catches a leak and a test that
catches the leaks you thought of: a token in a field called `data`, or nested three
levels into a context object, is found by value and missed by any name-based check.

It caught a real one. The policy-summary test originally asserted that no key matched
`/secret|key|password/`, which failed on the legitimate field names `apiKeys` and
`passwords` — so it was rewritten to assert on values, which is both correct and
stricter.

## The twenty-one categories

`SECURITY_TEST_CATEGORIES` is a checklist, not a framework. It lists what a credential
path is expected to cover: token forgery, signature bypass, issuer and audience
confusion, expiry handling, cross-tenant access, role escalation, scope escalation,
credential leakage, enumeration, timing, lockout, rate limiting, session fixation,
refresh reuse, revocation, actor-type confusion, privilege escalation via grant, header
manipulation, redaction, default-deny, and configuration refusal.

Use it as a review prompt when adding a credential type. It is deliberately a list of
21 short strings rather than a test generator, because a generated security test tests
the generator.

## Two trails

They are different things with different audiences, and conflating them makes both
useless.

|              | Audit trail              | Security events                |
| ------------ | ------------------------ | ------------------------------ |
| Answers      | who changed this record  | what was attempted and refused |
| Has an actor | always                   | usually not                    |
| Scope        | one organization         | platform                       |
| Read by      | the customer, an auditor | whoever runs the platform      |
| API          | `AuditService`           | `SecurityEventEmitter`         |

A failed login for an unrecognised email has no actor and no organization, and it is one
of the most useful records there is. It does not belong in a customer's audit trail.

`AuditSecurityEventSink` bridges the two through an **allow-list**,
`AUDITABLE_SECURITY_EVENTS`. Only events a customer should see cross over — a revoked
key, a role change, a session revocation. Perimeter noise (rate limiting, failed logins
against unknown addresses) stays out, because a customer trail full of internet
background radiation is a trail nobody reads.

Two guarantees in `SecurityEventEmitter`, both tested:

1. **A sink failure never propagates.** An authentication that succeeds and then 500s
   because the event store was unreachable is worse than one that succeeds unrecorded.
   Every sink is called even if an earlier one throws, and the failure is logged.
2. **Context is redacted before dispatch** — once, in the emitter, not in each sink
   where one forgetting would be enough.

Critical events are additionally logged directly, in case a sink is misconfigured: the
application log is the one place an operator is already looking.

## Redaction

`redactSecrets` walks a structure and replaces the values of secret-named fields with
`[REDACTED]`. Depth-limited and cycle-safe.

It has an allow-list, `SAFE_IDENTIFIER_FIELDS`, checked before the pattern match, and
it exists because of a real bug: `sessionId`, `credentialPrefix` and `credentialType`
were being stripped, because "session" and "credential" are secret patterns. The
security portal could not revoke a session or identify a credential, because the
identifiers it needed were redacted.

The list is deliberately short and a test caps its length, so it stays reviewable. Every
entry is an identifier that is _displayable by design_: a prefix, a type, an id.

Redaction is a safety net, not a licence. A field named `data` holding a token is caught
by no name-based redactor — which is why `assertNoLeakedValues` searches by value.

## Running the suite

```bash
npm test                              # everything: 1000+ tests
npx vitest run packages/identity      # one package
npx vitest run packages/authorization
npx vitest run apps/security-admin-example   # the boot test

npm run lint
npm run format:check
npm run build:packages
npm run migrate:drift -w @trustsystem/database    # needs a database + shadow database
```

The boot test deserves a mention. A package can pass every one of its own tests and
still be unusable: a `@Global()` module that declares a provider without exporting it, a
guard whose dependency is not visible from the module that registers it, a controller
injecting a token nothing provides. All three are start-up failures that only booting
finds, and unit tests cannot find them because a unit test constructs the class directly
and never asks the injector to resolve anything.

`apps/security-admin-example/src/security-admin.spec.ts` boots the real composition root
with in-memory stores and asserts that the injector resolves, that the seven guards are
registered in the documented order, and that no `GET` route exists that could return a
credential value. Every one of those assertions has already failed once during
development, which is the argument for it.

## CI gates

The `security` job fails the build on:

| Gate                   | Fails on                                                   |
| ---------------------- | ---------------------------------------------------------- |
| Secret scanning        | any credential-shaped string in the working tree           |
| `npm audit`            | a **critical** advisory in production dependencies         |
| Lockfile validation    | `npm ci` unable to install from the committed lockfile     |
| Static analysis        | a lint error (the security rules are errors, not warnings) |
| Identity tests         | any failure in `packages/identity`                         |
| Tenant-isolation tests | any failure in the cross-tenant suite                      |
| Authorization tests    | any failure in `packages/authorization`                    |
| Licence report         | generated as an artefact; does not fail                    |
| Reproducibility        | two generations from identical inputs differing            |

High-severity advisories are reported and do not fail, because a high advisory in a
transitive development dependency should not stop a security fix from shipping.
Critical does fail.

## The exception process

Sometimes a critical advisory has no fix. The process, in the order the steps have to
happen:

1. **Confirm it is not exploitable here.** Which package, which function, is it reachable
   from the framework's code paths at all? A critical advisory in a code path nothing
   calls is different from one in the request path.
2. **Look for a real fix first** — a version bump, an override, a replacement, removing
   the dependency.
3. **If none exists, record it** in `.security-exceptions.yml`:

   ```yaml
   - advisory: GHSA-xxxx-xxxx-xxxx
     package: some-transitive-dep
     severity: critical
     reason: >
       Reachable only from the SVG rasteriser, which this framework does not use.
       Verified by tracing the import graph from packages/*/src.
     mitigations: Not called. Removed from the bundle by the build.
     accepted-by: security-owner@example.com
     accepted-on: 2026-07-30
     expires: 2026-10-30
   ```

4. **Expiry is mandatory**, maximum 90 days. An exception with no expiry is a decision
   nobody revisits, and the whole failure mode this process exists to prevent is a
   permanent "we know about that one".
5. **On expiry the build fails again.** Renew it with a fresh justification, or fix it.

An exception is a dated decision by a named person, not a suppression.

---

**See also:** [threat-model.md](threat-model.md) ·
[incident-response.md](incident-response.md) ·
[security-standards.md](security-standards.md) ·
[authorization-model.md](authorization-model.md)
