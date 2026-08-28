# Data governance evidence

## The classifications

The six the pilot specification names, registered in `@trustos/data-catalog`:

| Entity                       | Classification      | Personal data | Purpose                                                          |
| ---------------------------- | ------------------- | ------------- | ---------------------------------------------------------------- |
| Merchant profile             | `CONFIDENTIAL`      | yes           | Operating merchant accounts and answering support enquiries      |
| Merchant wallet              | `RESTRICTED`        | no            | Holding merchant proceeds between acceptance and settlement      |
| Financial transaction        | `RESTRICTED`        | no            | Recording what was accepted, for settlement and dispute handling |
| Ledger journal               | `HIGHLY_RESTRICTED` | no            | The authoritative record of what money moved                     |
| Audit trail                  | `HIGHLY_RESTRICTED` | yes           | Evidence of who did what                                         |
| Public product documentation | `PUBLIC`            | no            | Telling prospective merchants what the product does              |

## What each classification obliges

Derived from the level, not declared per field. That is the point: a label with no obligations
attached is a label somebody sets to whatever makes their ticket pass.

|                     | Mask    | Export | Reveal needs approval | Cross-region | AI input |
| ------------------- | ------- | ------ | --------------------- | ------------ | -------- |
| `PUBLIC`            | no      | yes    | no                    | yes          | yes      |
| `CONFIDENTIAL`      | **yes** | yes    | no                    | yes          | yes      |
| `RESTRICTED`        | **yes** | yes    | **yes**               | **no**       | yes      |
| `HIGHLY_RESTRICTED` | **yes** | **no** | **yes**               | **no**       | **no**   |

So, for this pilot, without anybody writing a rule:

- The merchant profile and the wallet are **masked by default**.
- Revealing a wallet balance **needs a second person**.
- The ledger and the audit trail **cannot be exported**.
- The ledger **cannot be an AI input**.

## Demonstrated

| Demonstration                           | Result                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Masking derived from the classification | **Pass** — `CONFIDENTIAL` and above mask                                 |
| Access restriction                      | **Pass** — an unauthorized catalog search returns a stub, not the schema |
| Controlled reveal                       | **Pass** — `RESTRICTED` requires approval; the policy denies without one |
| Audit of the reveal                     | **Pass** — the policy decision is recorded with its version              |

## The inheritance check

A test registers the wallet table as `INTERNAL` with a `RESTRICTED` balance column, and
`misclassified()` returns it.

That is the mistake worth catching, because it reads reasonably: a wallet table is a balance, not a
payment, and `INTERNAL` looks defensible until you notice it removes masking from a figure the
ledger protects.

## Access restriction, specifically

`DataCatalog.search` takes an `authorized` flag deciding whether full metadata comes back or a
stub. The pilot resolves that flag **server-side from the actor's permissions**, never from a query
parameter.

A query parameter there would make the whole classification model a suggestion, and it is exactly
the sort of parameter added for a legitimate internal reason and never removed.

The stub is `entryId`, `businessName`, `kind`, `classification` and `owner` — enough to know the
entry exists and who to ask, and not enough to learn the schema.

## The AI boundary

Two controls agreeing, which is the point:

- `obligationsFor('HIGHLY_RESTRICTED').aiInputPermitted` is `false`.
- No feature's input allow-list in `@trustos/governance-ai-bridge` names a ledger or journal input,
  asserted across every feature rather than the ones somebody remembered.
