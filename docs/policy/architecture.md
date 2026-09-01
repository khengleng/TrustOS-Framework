# Policy-as-code architecture

Four packages, one rule that shapes all of them: **a policy document can refuse, and can never
grant.**

## The split with `@trustsystem/authorization`

The framework already has an authorization engine. `@trustsystem/authorization` decides _who may call
what_ — it is code, it is the same on every deployment, and it is where the default-deny structure
lives.

The policy engine decides _what the rules currently are_. Whether a partner may reach restricted
data outside business hours, whether a consumer in overage may still call, whether an unreviewed
consumer keeps working. Those differ per deployment and change without a release, which is what
makes them configuration.

They compose through an adapter:

```ts
const decision = engine.asAuthorizationPolicy({ policyId, decisionFor });

// On DENY: { effect: 'deny', reason: '...' }
// On ALLOW: null — it abstains
```

The abstention is the whole design. A document policy that could grant would let somebody edit
configuration past a code refusal, and the default-deny structure would then depend on nobody
writing an over-broad document. Code decides first; if code says no, no document changes it.

## The four packages

**`@trustsystem/policy-registry`** holds versioned, immutable documents. `defaultEffect` is
`z.literal('deny')` — the schema refuses anything else, because a policy whose default is allow
permits everything it did not think of, and the things a policy did not think of are exactly the
interesting ones.

Test cases are required, and at least one for each outcome the policy can produce. A policy that
denies everything passes any set of deny-only tests.

**`@trustsystem/policy-evaluator`** evaluates. Deterministic: no clock, no I/O, no randomness. Given
the same version and the same attributes it returns the same decision on any machine in any year,
which is what makes a logged decision **re-derivable** rather than merely believed.

**`@trustsystem/policy-decision-log`** records. Every decision, allow and deny — a decision point that
logged only denials answers "what did we refuse" and not "what did we permit", and the second is
the question an auditor asks about a breach.

**`@trustsystem/policy-engine`** is the three together plus enforcement.

## First match wins, by priority then by id

The id tiebreak matters. Two rules at the same priority would otherwise be ordered by however the
array arrived — from a database, a file or a merge — and the decision would depend on iteration
order.

## An obligation nobody understands is a denial

```ts
assertObligationsUnderstood(decision, supportedObligations);
```

Without this rule, a caller that silently ignored an unknown obligation would turn every _future_
obligation into a no-op for every _existing_ caller. And obligations are added precisely when a
permission needs a condition attached — "allowed, but log it", "allowed, but mask this field" — so
ignoring them converts a conditional permission into an unconditional one.

The default `supportedObligations` in the example application is empty, so any policy carrying an
obligation denies until the deployment declares what it can honour.

## A draft cannot decide

`PolicyEngine.decide` refuses a policy whose status is not active, even when a version is pinned
explicitly. A draft policy that could decide would take effect the moment somebody wrote it.

`simulate` evaluates anything, including drafts, and records nothing. That is the point of
simulating — a policy whose behaviour can only be observed after activation is a policy nobody can
review.

The two are separate routes in the console and separate CLI commands, deliberately. One route with
a `dryRun` flag would be smaller code and a worse system: the flag defaults somewhere, and a
mistake in the default is either an unrecorded decision or an enforced draft.

## Missing attributes are reported

```ts
decision.missingAttributes; // ['consumerKind']
```

A rule reading an attribute nobody supplied never fires — and in a review, a rule that never fires
looks exactly like a rule that never needed to. `@trustsystem/api-policy` goes further and refuses a
policy that reads an attribute the API layer never supplies, at load time.
