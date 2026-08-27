# Masking, tokenization and pseudonymization

Three different things, often conflated, with different reversibility.

`@trustos/data-masking` reuses `@trustos/governance-pii-policy` for the masking rules themselves
rather than restating them — one definition of what a masked card number looks like, in one place.
What this package adds is the two operations that are not masking.

## Masking

Irreversible, display-oriented. `mask(value, policy)` produces something a person can recognize and
cannot use: `**** **** **** 4242`.

The rules come from the classification: `maskByDefault` is true from `CONFIDENTIAL` upward, and
`rulesForClassification(level)` returns what applies.

The important property is that masking happens at the **read** boundary, not at write. Storing a
masked value loses the original, and the original is what the ledger reconciles against.

## Tokenization

Reversible, by a party holding the vault. `TokenVault` is a **port**, and the framework's default
implementation refuses:

```ts
refusingTokenVault(); // every method rejects
```

That default is deliberate. Tokenization implies a vault — a system that holds the mapping from
token to value — and the framework does not ship one, because a vault is a compliance boundary a
deployment chooses. A default in-memory implementation would be a vault in the application's own
process, which is not a vault.

The refusal is asynchronous. An earlier version threw synchronously from a `Promise`-returning
method, which meant a caller using `.catch()` would never see it — corrected, and the shape now
matches the interface.

## Pseudonymization

```ts
pseudonymize({ value, key, scope });
```

Keyed and scoped. The same value under two scopes produces two different pseudonyms, which is what
stops a pseudonym in one system being joined against the same pseudonym in another.

A pseudonym is **not** anonymization. It is a stable identifier for a person, and it is personal
data. `personalData` stays true on a pseudonymized field, and the retention rules still apply.

Getting this wrong is the most common data protection mistake in a platform of this shape: a table
of hashed identifiers is treated as anonymous, retained forever, and shared freely — and it
re-identifies against any other table that has the same hashing.

## Where masking is decided

The masking obligation comes from the classification, but the _decision_ to reveal is
`@trustos/data-access-policy` — see [`../enterprise-governance/operating-model.md`](../enterprise-governance/operating-model.md)
for why the request and the approval are different permissions.
