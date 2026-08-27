# Pilot architecture

## What it is

A merchant payment acceptance product built on TrustOS, with nothing new below the application
layer.

```text
                    apps/merchant-wallet-basic
                    ┌──────────────────────────────────────────┐
                    │  domain/merchant.ts    the domain model   │
                    │  domain/onboarding.ts  maker-checker      │
                    │  domain/payment.ts     the flow           │
                    │  permissions.ts        19 keys, 6 roles   │
                    │  pilot.ts              the assembly       │
                    └──────────────────────────────────────────┘
                                      │
        ┌─────────────────┬───────────┼───────────┬─────────────────┐
        ▼                 ▼           ▼           ▼                 ▼
   financial         governance    product     platform        enterprise
   ┌──────────┐    ┌───────────┐ ┌──────────┐ ┌──────────┐   ┌─────────────┐
   │ ledger   │    │ audit     │ │ composer │ │ errors   │   │ data-*      │
   │ wallet   │    │ rbac      │ │ sandbox  │ │ config   │   │ policy-*    │
   │ accounts │    │ tenancy   │ │ simulator│ │ logging  │   │ api-*       │
   │ fees     │    │ identity  │ │ runtime  │ │ database │   │ sre / slo   │
   │ limits   │    │ authz     │ │ versions │ │ shared   │   │ backup / dr │
   │ fin-core │    └───────────┘ └──────────┘ └──────────┘   └─────────────┘
   └──────────┘
```

Sixty-one framework packages in the transitive closure. 1,822 application lines.

## The payment flow

```text
POST /api/payments  { merchantId, amount, currency, reference }
        │
        ├─ 0. idempotency         replay if this reference was accepted
        ├─ 1. validate merchant   approved, in this organization
        ├─ 2. check product       bound to a version, currency matches
        ├─ 3. check wallet        exists, not frozen
        ├─ 4. consume limit       reserve, not check — @trustos/limits
        ├─ 5. mock risk rule      a declared mock, pluggable
        ├─ 6. mock provider       a declared mock, can time out
        ├─ 7. calculate fee       @trustos/fees, from the schedule
        ├─ 8. post ledger         one journal, three entries, balanced
        └─ 9. return              gross, fee, net, journal id, correlation id
```

Four properties of that order are decisions rather than consequences.

**Idempotency is first**, before anything is checked or counted. A retry must not consume the limit
a second time or post a second journal, and both would be invisible to the merchant — who sees one
response either way — and discovered by a reconciliation weeks later.

**The limit is consumed, not checked.** `LimitEngine.check` tells a caller what they could do; two
concurrent callers both pass it. `consume` reserves. A path that checked would let a merchant
exceed a daily limit by the number of requests in flight, which is small and is exactly the number
that matters when the limit is a fraud control.

**One journal, not two.** The gross debits clearing, the net credits the merchant's wallet account,
the fee credits revenue. Posting the payment and the fee separately means a window in which the
merchant's balance is wrong, and that window is where a reconciliation exception is born.

The wallet balance is _derived_ from the ledger — `WalletService.balance` reads the account
balance, which is the journals. So the flow posts and does not also call `credit`, which would post
a second journal and count the money twice. The pilot's first version did exactly that.

**The ledger is last, and the payment is not confirmed before it.** If the posting fails, the
payment failed. A transaction marked accepted whose journal did not post is money the platform
believes it holds and cannot account for.

When the posting fails, the limit has already been consumed under the same key. That is the correct
direction to be wrong in: the merchant can retry with the same reference and the limit will not
double-count.

## The merchant model

Five entities: Organization → Merchant → Store → Branch, with Merchant Users attached.

**A merchant is not a tenant.** The organization is the framework's tenant and stays so. A merchant
is a record inside one.

Making the merchant the tenant reads as the natural mapping — one merchant, one set of data, one
boundary — and it means every framework package that scopes by `organizationId` scopes by the wrong
thing. Every isolation test in the framework would still pass while the application leaked across
merchants inside a single organization, which is the worst available failure: a test suite that is
green and a control that is absent.

Cross-merchant access inside one organization is therefore a _permission_ question — `finance` and
`operations` see other merchants; `merchant_owner` and `cashier` do not — and cross-tenant access
is an isolation question, refused before any permission is consulted.

## Maker-checker, in two shapes

**Onboarding** is a state machine where maker and checker act on the same record at different
states. `assertApprovable` refuses an approver who verified _or_ registered it. Both, because
excluding only the immediately preceding actor is satisfied by one person registering, a second
verifying, and the first approving.

**A limit change** is a request that exists separately from the thing it changes. Nothing changes
until it is approved, and the pending request is a record somebody can see, cancel or reject with a
reason.

The second shape is the one people skip, because "change the limit and audit it" is one line. The
difference appears the first time a limit is raised at 2am by somebody who then leaves: with a
request there is a decision to read, and with an audited edit there is a row saying what happened
and nothing saying why it was allowed.

## The mocks, declared

Three, and each is named in the code as a mock:

- `alwaysAuthorizes` — a payment provider that authorizes everything and times out on a reference
  beginning `PROVIDER-TIMEOUT`.
- `defaultRiskRule` — refuses a reference beginning `RISK-REFUSE`.
- The stores — every one is an in-memory implementation of a framework port that has a Prisma
  implementation the pilot does not bind.

The risk rule is deliberately trivial. The pilot needs a refusal path to test; it does not need a
risk engine, and a plausible-looking one here would be the first thing somebody copied into
production.

## What the pilot deliberately does not do

- No HTTP layer. The pilot is a library plus tests. Three applications in this repository show the
  NestJS composition, and repeating it would have measured the framework's guard chain a fourth
  time rather than measuring anything new.
- No identity provider. Actors are strings.
- No database. Every port has a Prisma implementation; none is bound.
- No real payment rail, by instruction.
