# Step 1C — deployed authentication validation

**Result: Authentication remains PARTIAL. One prerequisite is left, and it is a
four-checkbox change in the Keycloak Admin Console.**

Re-verified at commit `a77b4d788694`: the validator client in `trustos-dev` is still public,
and no client secret has been supplied to the DEV environment. The credential-dependent
checks therefore remain `NOT_REACHED`, reported as SKIP and counted as neither pass nor
failure. See [foundation-v0.1.md](foundation-v0.1.md) for the seven-control matrix.

Both blockers reported previously are gone. DEV now genuinely validates OIDC tokens, and
the deployed runtime has been observed refusing a token it could not verify. What is
still missing is a machine credential, and section 3 of the brief is explicit: report the
missing prerequisite rather than fabricate a pass.

## What changed since the last run

|                                                      | Previously                | Now                                                             |
| ---------------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| `trustos-dev` realm                                  | absent (404)              | **exists**, 2 signing keys published                            |
| `trustos-uat` realm                                  | absent (404)              | exists (empty of clients)                                       |
| DEV identity mode                                    | `IDENTITY_PROVIDER=local` | **`oidc`**, issuer `https://id.cambobia.com/realms/trustos-dev` |
| DEV portal config                                    | `identity: null`          | advertises the dev issuer                                       |
| `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION` on DEV | `true`                    | **removed**                                                     |
| Readiness                                            | `database` only           | `database` + `identity`                                         |

DEV was deployed from the working tree rather than by merging to `main`, because `main`
builds PROD and the brief says not to change it.

## Which clients exist, and where

Determined by probing rather than by asking — the authorization endpoint distinguishes a
client that exists from one that does not, and the token endpoint distinguishes a public
client from a confidential one.

|                                | `trustos` (PROD) | `trustos-dev`       | `trustos-uat` |
| ------------------------------ | ---------------- | ------------------- | ------------- |
| `trustos-api`                  | yes              | —                   | —             |
| `trustos-web`                  | yes              | —                   | —             |
| `trustos-foundation-validator` | —                | **yes, but public** | —             |

## The one remaining blocker

`trustos-foundation-validator` exists in `trustos-dev` and cannot authenticate. Both
`client_credentials` and `password` grants return `unauthorized_client` rather than
`invalid_client`, which is what Keycloak says about a client it can find but that is not
configured to present a secret at all. It is a public client.

Three changes in the Admin Console, on that client in the `trustos-dev` realm:

1. **Client authentication → On.** This is what makes it confidential and gives it a secret.
2. **Service accounts roles → On.** Without it there is no client-credentials grant.
3. **A dedicated audience mapper emitting `trustos-api`.** By default Keycloak puts
   `account` in `aud` for a service-account token, and DEV is configured to accept
   `trustos-api`. `azp` will be `trustos-foundation-validator`, which DEV already accepts
   because it is listed in `OIDC_ADDITIONAL_AUDIENCES`.

Grant it no realm-management roles, no PROD access and no UAT access. It exists to hold a
token, not to administer anything.

**The secret must not pass through a chat transcript.** Set it directly:

```bash
read -rs SECRET \
  && printf '%s' "$SECRET" \
  | railway variable set --stdin TRUSTOS_VALIDATION_CLIENT_SECRET \
      -s governance-tool -e dev --skip-deploys \
  && unset SECRET
```

`read -rs` does not echo and leaves nothing in shell history; `--stdin` keeps the value off
the command line. The syntax above has been run end to end against DEV with a placeholder,
which was then deleted.

The validation run reads it back without printing it:

```bash
TRUSTOS_VALIDATION_ISSUER=https://id.cambobia.com/realms/trustos-dev \
TRUSTOS_VALIDATION_CLIENT_ID=trustos-foundation-validator \
TRUSTOS_VALIDATION_CLIENT_SECRET="$(railway variables -s governance-tool -e dev --kv \
  | sed -n 's/^TRUSTOS_VALIDATION_CLIENT_SECRET=//p')" \
npm run validate -- --deployed --base-url https://governance-tool-dev.up.railway.app
```

The raw access token is never logged; the run records only the issuer, audience and
authorized party that were accepted.

## What is now proven on the deployed runtime

Unconditionally, with no credential required. Commit `a77b4d788694`.

```
PASS  readiness                          GET /ready -> 200, identity: ok
PASS  protected-route-refuses-anonymous  GET /api/governance/apps -> 401
PASS  forged-token-refused               bearer "not-a-token" -> 401
PASS  auth-untrusted-signature-refused   valid claims, untrusted key -> 401
```

### The six negative cases, and what each actually establishes

Every case was refused with 401. The rejection reason and the time taken were read from
the service's own logs, because the response body is deliberately identical in all six —
which is correct, and is also why the response alone cannot say which check fired.

| Case                             | Status | Time        | Reason recorded       | What it establishes                                       |
| -------------------------------- | ------ | ----------- | --------------------- | --------------------------------------------------------- |
| A — no bearer token              | 401    | 1.72ms      | none                  | Refused at the guard. No crypto, no network               |
| B — garbage, non-JWT             | 401    | 6.60ms      | `oidc_token_rejected` | Reached the OIDC provider and failed to parse             |
| C — valid shape, unpublished key | 401    | **39.75ms** | `oidc_token_rejected` | A JWKS lookup and a real signature check happened         |
| D — expired                      | 401    | 4.46ms      | `oidc_token_rejected` | Denied — **but at key resolution, not for being expired** |
| E — wrong issuer                 | 401    | 4.71ms      | `oidc_token_rejected` | Denied — **but at key resolution, not for its issuer**    |
| F — wrong audience               | 401    | 4.28ms      | `oidc_token_rejected` | Denied — **but at key resolution, not for its audience**  |

D, E and F were signed with a key the realm does not publish, because that is the only
kind of token that can be minted without the validation credential. jose resolves the
signing key before it evaluates any claim, so all three were refused on an unknown `kid`
— in about 4.5ms, against C's 39.75ms, because by then the JWKS was cached and the key
was known to be absent.

They satisfy "expected: DENY". They do **not** demonstrate that the expiry, issuer or
audience checks work, and recording them as though they did would be the overclaim this
exercise exists to prevent. Isolating those three needs a token this realm actually
signed.

The last one is new and is the first deployed evidence that DEV verifies signatures.
`Bearer not-a-token` proves little — it fails to parse, so a runtime that verified nothing
would still reject it. This asks the deployment which issuer and audience it trusts, mints
an RS256 token carrying exactly those claims plus a matching `azp`, and signs it with a key
the realm has never published. Only signature verification can refuse it.

DEV refused it, recording `reason="oidc_token_rejected"`, in **81.13ms** — against
**1.44ms** to refuse an anonymous request. The 56x difference is the JWKS fetch and the
signature check actually happening.

## A denial of service, found by running this

Readiness reported identity `down` on DEV part-way through, and the cause was this
repository's own validator sending forged tokens at it.

`keyFetchFailures` was incremented in the catch of `validateAccessToken`, which catches
every rejection — an expired token, a bad signature, a `kid` the realm does not publish.
Five of those marked identity unhealthy. The indicator is critical, so `/ready` returned
503 and the instance left rotation. **Anyone able to reach the API could switch a node off
with five invalid bearer tokens, no credential required.**

Only a failure to _retrieve_ the provider's keys counts now. The classification is narrow
on purpose: an unrecognised error is not treated as an outage, because a real outage
produces a timeout or a network error reliably, whereas defaulting the unknown case to
"unhealthy" restores exactly the problem.

A test asserted the old behaviour, which is why it survived. It is replaced by one that
refuses thirty bad tokens and expects health to hold, plus two covering the case the
counter is actually for.

Verified on the deployed runtime: 25 forged tokens, five times the old threshold, and
`/ready` stayed `200 ok`.

This is the readiness indicator added in the previous step earning its place — it was
built to report identity honestly, and the first thing it reported honestly was a fault
in the thing it was reporting on.

## Requirements checked without identity administration

| Requirement                              | State                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| §7 — fail closed, no OIDC→local fallback | **holds.** No fallback path exists. An unreachable JWKS raises `unauthorized` rather than admitting the request                         |
| §8 — startup validation                  | **holds.** `IDENTITY_PROVIDER=oidc` without `OIDC_ISSUER_URL` or `OIDC_CLIENT_ID` refuses to start                                      |
| §9 — readiness reflects identity         | **holds, and is now live on DEV.** `/ready` reports `identity: ok — token verification available`, and discloses no issuer or key state |

## Subchecks deliberately not attempted

| Check               | Status         | Why                                                                                                                                                           |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong issuer        | NOT_APPLICABLE | Would mean configuring a second, untrusted issuer on DEV. Section 9 permits relying on unit evidence rather than weakening issuer validation to create a test |
| Wrong audience      | NOT_APPLICABLE | Same reasoning. PROD's `azp` refusal is real evidence that audience and authorized party are enforced                                                         |
| Expired token       | NOT_REACHED    | Needs a token signed by the realm, which needs the credential above                                                                                           |
| Logout / revocation | NOT_REACHED    | Short-lived stateless access tokens; the semantics to document need a session to create first                                                                 |

## Also true, and not part of this step

- `trustos-web` does not exist in `trustos-dev`, so **browser sign-in to the DEV portal
  will not work** until it is created. DEV is configured to expect it. The machine-token
  path this step validates does not depend on it.
- `trustos-uat` has no clients at all and will need the same treatment before UAT can
  move off local identity.

## Status

**Authentication: PARTIAL** — per section 18. Four of the deployed checks pass
unconditionally, including signature verification. The three that need a genuine token
report `NOT_REACHED`, which is the honest description of evidence not gathered. Not FAIL:
nothing was observed behaving incorrectly, and the one defect found was found, fixed,
tested and redeployed.
