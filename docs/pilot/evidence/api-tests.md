# API management test evidence

## The registered API

|                 |                                                              |
| --------------- | ------------------------------------------------------------ |
| API             | `mwb.payments@1.0.0`                                         |
| Domain          | financial                                                    |
| Environment     | production                                                   |
| Lifecycle       | PUBLISHED                                                    |
| Business owner  | `usr_product`                                                |
| Technical owner | `usr_platform`                                               |
| Authentication  | `api_key`                                                    |
| Classification  | **`RESTRICTED`** — derived from its operations, not declared |
| Objective       | `mwb.api.availability`                                       |
| OpenAPI         | `docs/pilot/evidence/mwb-payments-1.0.0.yaml`                |

Two owners, both required to publish. The business owner decides whether a consumer gets an
exception; the technical owner decides whether a change is safe. Collapsing them means one of those
decisions gets made by whoever is nearest.

## The registered consumer

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Consumer    | `con_alpha_pos` — Alpha Coffee point of sale                       |
| Kind        | `merchant` (ceiling: `CONFIDENTIAL`)                               |
| Environment | production                                                         |
| Entitlement | `mwb.payments` major 1, scope `payments:write`, expires 2027-01-15 |
| Plan        | `plan_merchant` — 3 calls/month, 5 calls/minute                    |

## Results

| Test                                      | Result                                  |
| ----------------------------------------- | --------------------------------------- |
| An authorized consumer                    | **Allowed**                             |
| An unauthorized consumer                  | **Refused** — `consumer_not_registered` |
| A write scope reading                     | **Allowed** — write covers read         |
| A read-only consumer writing              | **Refused** — `scope_not_granted`       |
| Above the rate limit                      | **Refused at `rate`**                   |
| Quota exhausted                           | **Refused at `quota`**                  |
| A version the consumer is not entitled to | **Refused** — `no_entitlement`          |
| Refusals counted in analytics             | **Pass** — 2 requests, 1 refused        |

## Why a write scope may read

`@trustsystem/api-keys`' rule, reused rather than restated: a credential that may change something can
necessarily observe it.

The pilot's first version of this test asserted the opposite and was wrong. Requiring both scopes on
every credential is how every credential eventually gets a wildcard.

## Why an entitlement covers one major version

The consumer is entitled to `mwb.payments` **major 1**. Minors and patches within it are included,
because they are compatible by definition; `2.0.0` is refused.

An entitlement that tracked "the newest version" would silently grant whatever the next major adds
— including operations nobody reviewed against this consumer.

## Why rate and quota refuse separately

A rate limit protects the service's capacity; a quota protects the commercial arrangement. They
carry different headers (`RateLimit-*` and `Quota-*`) because a client that cannot tell which
boundary it hit cannot respond to either: slowing down does not help an exhausted quota, and buying
more quota does not help a breached rate limit.

## The order of the gate

```text
catalog → entitlement → policy → rate → quota
```

Quota is last because it is the only stage that costs the consumer something. Counting it earlier
means a caller can be billed for calls that were refused, and a misconfigured integration hammering
a 403 would exhaust the quota of the party it was refused for.
