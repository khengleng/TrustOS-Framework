# API key security

Long-lived credentials for machine callers, built so that a database leak does not
hand anyone a working key.

- [Format](#format)
- [Storage](#storage)
- [Lifecycle](#lifecycle)
- [Rotation](#rotation)
- [Scopes](#scopes)
- [IP allowlists](#ip-allowlists)
- [Verification order](#verification-order)
- [Configuration](#configuration)
- [Operational notes](#operational-notes)

---

## Format

```
tos_live_7k2m9x4qp8n3vw6ytr5zh1jd0bscf2ge
└┬┘ └─┬┘ └──────────────┬──────────────┘
 │    │                 └── 32 characters, 160 bits of entropy
 │    └── environment: live | test
 └── fixed prefix, so a leaked key is recognisable
```

The fixed `tos_` prefix exists so that a secret scanner — the one in this repository's
CI, or GitHub's — can recognise a leaked key in a commit or a paste. A credential that
looks like a random string is one nobody notices.

`live` and `test` are separate namespaces, and `assertKeyEnvironment` refuses a test
key in a production process. A test key that works in production is a test key that
someone will use in production.

The alphabet is a Crockford-style base32 without `i`, `l`, `o` and `u` — so a key read
aloud or copied from a screenshot is unambiguous, and no substring forms an unfortunate
word. Generation uses **rejection sampling**: taking `randomBytes` modulo a 32-character
alphabet is uniform, but the same code with a 30-character alphabet is biased toward
the first two characters, and that is the kind of thing that gets copied.

The **prefix** stored alongside the hash is the first 12 characters
(`tos_live_7k2m`). It is what a UI shows, what a log line records, and what somebody
matches against when a key turns up in a paste. It is not enough to authenticate with.

## Storage

Three columns, and none of them is the key:

| Column      | Contents                                                   |
| ----------- | ---------------------------------------------------------- |
| `keyPrefix` | `tos_live_7k2m` — displayable, not usable                  |
| `keyHash`   | SHA-256 of the full key                                    |
| metadata    | name, scopes, expiry, IP allowlist, last-used, usage count |

**The plaintext exists for the lifetime of one response.** `create` and `rotate`
return it; nothing else can, because nothing else has it. There is no "reveal key"
endpoint because there is nothing to reveal, and the security administration API's only
`GET` routes over keys return metadata and usage.

SHA-256, not scrypt — and that is deliberate. Password hashing is slow because a
password has perhaps 40 bits of entropy and must survive an offline attack. An API key
has 160 bits of server-generated entropy: it is not guessable, so the slow hash buys
nothing, and it would cost 100ms on every authenticated request. Comparison is
`timingSafeEqual`.

## Lifecycle

**Create** — validates the scopes against the allowed set, refuses a duplicate name in
the organization, refuses to exceed the per-organization ceiling, applies the default
expiry.

The name check exists because a name is how a person identifies the key they are about
to revoke; two keys sharing one is a revocation aimed at the wrong credential. The
ceiling bounds the blast radius of a leak and makes an unusual number of keys something
an administrator has to notice.

**Revoke** — sets `revokedAt` and is **idempotent**. A revocation is what somebody does
during an incident, and the second click must not produce an error that looks like a
failure.

**Expiry** — every key gets one. `maxLifetimeSeconds` caps it. A key with no expiry is a
key that outlives the integration it was made for, the person who made it, and any
memory of why it exists.

**Usage tracking** — `lastUsedAt`, `lastUsedIp` and `usageCount`. The first question in
a leak investigation is "has it been used, and from where", and it is answerable
without the key value.

## Rotation

```
POST /security/api-keys/:id/rotate
```

Returns a new key and leaves the old one valid for a grace period. Both work during the
window, so the caller can deploy the new value, verify traffic, and then revoke the old
one — rotation that causes an outage is rotation nobody performs, and a credential
nobody rotates is worse than a brief overlap.

Scopes and the IP allowlist carry over. The response states the grace period
explicitly, because a grace period nobody was told about is an outage with extra steps.

Service-account credentials rotate with **no** grace period — different trade-off, for
reasons in [service-account-security.md](service-account-security.md).

## Scopes

Server-side, always. `payments:write` covers `payments:read`; the reverse never holds.

```
payments:read      payments:write
merchants:read     merchants:write
webhooks:manage    reports:read
```

Examples. The allowed set is configuration and a product defines its own. Two
enforcement points, `ScopeGuard` and `credentialScopePolicy`, and an action with no
scope mapping is **denied** — a new endpoint is unreachable by an API key until
somebody maps it deliberately.

## IP allowlists

Optional per key. Supports IPv4, IPv6 and CIDR ranges, matched byte-wise;
IPv4-mapped IPv6 addresses (`::ffff:203.0.113.9`) are normalised, so a client that
connects over a dual-stack socket is not mysteriously refused.

**A missing client address plus a non-empty allowlist is a deny.** If the allowlist
cannot be evaluated, it has not been satisfied. The alternative — treating "unknown" as
"allowed" — makes the allowlist decorative behind any proxy that drops the header.

An allowlist is defence in depth, not a substitute for anything: source addresses are
spoofable in some topologies and NAT means "one address" often means "a building".

## Verification order

1. **Shape.** Malformed → reject without a database query. Cheap rejection of noise.
2. **Hash lookup.** Not found → reject.
3. **Revoked?** → reject.
4. **Expired?** → reject.
5. **IP allowlist.** → reject.
6. **Resolve access** — the organization's roles and permissions, server-side.

Every failure returns the identical error. A response that distinguishes "no such key"
from "revoked" from "wrong IP" tells whoever holds a leaked key exactly which of four
things to change. `reason` goes to the security event.

Each attempt emits `api_key.auth_succeeded` or `api_key.auth_failed` with the prefix —
never the key.

## Configuration

| Variable                            | Default | Meaning                           |
| ----------------------------------- | ------- | --------------------------------- |
| `SECURITY_API_KEY_MAX_PER_ORG`      | 20      | Active keys per organization      |
| `SECURITY_API_KEY_DEFAULT_LIFETIME` | 365d    | Applied when none is given        |
| `SECURITY_API_KEY_MAX_LIFETIME`     | 730d    | Hard ceiling                      |
| `SECURITY_API_KEY_ROTATION_GRACE`   | 24h     | Old key's validity after rotation |

## Operational notes

**When a key leaks.** Revoke it, then rotate — in that order. Rotating first leaves the
leaked key valid for the grace period. Check `lastUsedAt` and `lastUsedIp`, and read the
security event trail for `api_key.auth_succeeded` from unexpected addresses. Full
procedure in [incident-response.md](incident-response.md).

**Keys cannot create keys.** Every route on the API key controller is
`@HumanActorsOnly()`. An API key that can mint API keys turns one leaked credential
into a permanent foothold that survives its own revocation.

**Permissions.** `security.api_key.read`, `.create`, `.rotate`, `.revoke`.
`organization_owner` holds all four; `administrator` holds read and revoke but not
create or rotate — containment during an incident is not the same authority as
minting a new long-lived credential. `auditor` holds read only.

---

**See also:** [service-account-security.md](service-account-security.md) ·
[authorization-model.md](authorization-model.md) ·
[incident-response.md](incident-response.md) ·
[threat-model.md](threat-model.md)
