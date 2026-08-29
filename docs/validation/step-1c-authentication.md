# Step 1C — deployed authentication validation

**Result: Authentication remains PARTIAL. Blocked on two prerequisites, both outside this
repository.**

Section 3 of the brief is explicit: if identity administration is unavailable, stop and
report the missing prerequisite rather than fabricate a pass. That is what happened.

## What was checked, and what it showed

|                           |                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- |
| Environment               | Railway DEV — `https://governance-tool-dev.up.railway.app`                      |
| Identity provider         | Keycloak at `https://id.cambobia.com`                                           |
| Realms present            | `trustos` only                                                                  |
| `trustos-dev` realm       | **absent** — `/realms/trustos-dev/.well-known/openid-configuration` returns 404 |
| `trustos-uat` realm       | absent — 404                                                                    |
| Keycloak administration   | **refused** — `trustos-admin` returns `401 Invalid user credentials`            |
| DEV runtime identity mode | `IDENTITY_PROVIDER=local`, no `OIDC_*` configured                               |
| DEV portal config         | `identity: null`                                                                |

## The two blockers

**1. No DEV realm, and no way to create one.** The `trustos-dev` realm does not exist. It
was not created earlier because the Keycloak admin credential was rotated — correctly,
on my own advice, after it had passed through a chat transcript. Creating a realm, a
scoped validation client and a test principal all require that administration access.

**2. DEV validates no tokens.** Even with a token in hand, the DEV runtime is configured
with `IDENTITY_PROVIDER=local` and no issuer, so it would not verify an OIDC token at all.
A "pass" obtained against a runtime that never checks a signature would be worse than no
evidence.

The second is mine to fix and takes one command — but only after the first, because the
issuer it must point at does not yet exist.

## What was built anyway

`npm run validate -- --deployed --base-url <url>` now includes the deployed authentication
scenario. It draws its inputs from the environment and never from source control:

```
TRUSTOS_VALIDATION_ISSUER          the environment's OIDC issuer
TRUSTOS_VALIDATION_CLIENT_ID       a DEV-only client scoped to this validation
TRUSTOS_VALIDATION_CLIENT_SECRET   its secret
```

With those present it obtains a token by client credentials, calls a genuinely protected
endpoint, and records the issuer, audience and authorized party that were accepted. The
raw token is never logged.

Without them, every authentication check reports **`NOT_REACHED`** — rendered `SKIP`, and
counted as neither a pass nor a failure. The overall verdict becomes `PARTIAL`, which is
the truthful description of a run that gathered no evidence. An ordinary local run needs
no deployed credential, which is what keeps this separable from the deterministic suite.

Current output against DEV:

```
PASS  protected-route-refuses-anonymous  GET /api/governance/apps -> 401
PASS  forged-token-refused               bearer "not-a-token" -> 401
SKIP  auth-valid-token-accepted          NOT_REACHED — TRUSTOS_VALIDATION_* required
SKIP  auth-actor-resolved                NOT_REACHED — TRUSTOS_VALIDATION_* required
```

Note what _is_ proven live and unconditionally: anonymous access and a forged bearer token
are both refused by the deployed runtime. Those are two of the five conditions section 18
requires. The missing three all need a genuine token.

## Why the existing evidence is not enough

Authentication has been verified before, and none of it is adequate here:

- OIDC signature, issuer, audience and authorized-party validation are covered by 57 unit
  tests
- The production runtime demonstrably verifies tokens — the `azp` fix was found _because_
  it rejected one
- MFA was proven end to end in a browser, with `acr` reporting the step-up

All of that is adjacent evidence. Section 1 of this brief forbids promoting on it, and the
prohibition is right: every one of those observations was made somewhere other than the
DEV runtime path this step exists to exercise.

## Exactly what unblocks this

1. **Keycloak administration for `id.cambobia.com`** — either the current `trustos-admin`
   password, or better, a service account in the `master` realm holding only
   `manage-realm`, which can be revoked independently and never needs to be a person's
   credential.

Everything after that is mine:

2. Create the `trustos-dev` realm from `docker/keycloak/realm-trustos.json`, plus a
   `trustos-validator` client scoped to this validation alone
3. Point DEV's runtime at it — `IDENTITY_PROVIDER=oidc`, `OIDC_ISSUER_URL`,
   `OIDC_CLIENT_ID`, `OIDC_ADDITIONAL_AUDIENCES` — and remove
   `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION`
4. Run the validator with the three environment inputs

## Subchecks deliberately not attempted

| Check               | Status         | Why                                                                                                                                                                                              |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong issuer        | NOT_APPLICABLE | Testing it against deployed DEV would mean configuring a second, untrusted issuer. Section 9 permits relying on existing unit evidence rather than weakening issuer validation to create a test. |
| Wrong audience      | NOT_APPLICABLE | Same reasoning. The production runtime's `azp` refusal is real evidence that audience and authorized party are enforced — it is simply not DEV evidence.                                         |
| Expired token       | NOT_REACHED    | Needs a signed fixture from the realm that does not exist.                                                                                                                                       |
| Logout / revocation | NOT_REACHED    | The architecture uses short-lived stateless access tokens; the semantics to document require a session to create first.                                                                          |

## Status

**Authentication: PARTIAL** — per section 18, because the deployed path could not be
fully exercised for want of identity administration. Not FAIL: nothing was observed
behaving incorrectly, and the two conditions that could be checked without a credential
both passed.
