# API management architecture

Eight packages. Seven answer one question each; the eighth puts them in an order, and the order is
the contribution.

## The gate

```text
1. Catalog       Does this operation exist?
2. Entitlement   May this consumer call it?          (code)
3. Policy        Does any deployment policy refuse?  (configuration, refuse-only)
4. Rate          Is the caller arriving too fast?
5. Quota         Has the caller used what they bought?
```

**Rate before quota**, because a rate breach is transient and a quota breach is not. Telling a
caller their quota is exhausted when they merely burst is a support ticket and — if the quota is
billable — an argument about money.

**Quota last**, because it is the only stage that costs the consumer something. Counting it before
an authorization failure means a caller can be billed for calls that were refused, and a
misconfigured integration hammering a 403 would exhaust the quota of the party it was refused for.

**Catalog first**, so a request for something undeclared never reaches the consumer registry, the
policy engine or the quota counter.

## Classification is derived, never declared

```ts
apiClassification(api); // the highest across its operations
```

A declared classification is a claim somebody made once. Deriving it means an API cannot be
labelled below what it actually returns — which is the mechanism by which a restricted field
reaches a public integration.

## Rate limit and quota are different things

A **rate limit** protects the service: it bounds how fast requests arrive so one caller cannot
consume the capacity everyone else needs.

A **quota** protects the commercial arrangement: it bounds how much a caller may consume over a
billing period.

They have separate headers (`RateLimit-*` and `Quota-*`) because a client that cannot tell which
boundary it hit cannot respond to either — slowing down does not help an exhausted quota, and
buying more quota does not help a breached rate limit.

## The fixed window is stated honestly

```ts
fixedWindowWorstCase(limit); // 2× the limit, for a fixed window
```

Sixty requests at 10:59:59 and sixty at 11:00:00 both pass a "sixty per minute" fixed window, and
the service sees a hundred and twenty in one second.

The framework defaults to sliding. `windowStrategy` says which is in use, so the number in the
documentation means what a reader thinks it means.

## Counting happens before deciding

Both the rate counter and the quota store increment and _then_ compare. A check-then-increment
store lets two concurrent requests both read a value below the limit and both proceed — the same
class of bug as checking a balance without reserving it.

## Money never floats

Overage prices are minor-unit strings and the arithmetic is `BigInt`. A month of overage at a
sub-cent unit price is exactly where a float loses a digit, and the number is on somebody's
invoice.

## Credentials stay in `@trustsystem/api-keys`

`@trustsystem/api-consumer` holds `credentialIds` — references — and never a key or a hash. The
separation matters beyond avoiding duplication: a consumer outlives its credentials, and modelling
entitlement on the key means the entitlement is re-granted at every rotation, usually by copying
whatever the old key had. That is how scopes accumulate and never shrink.
