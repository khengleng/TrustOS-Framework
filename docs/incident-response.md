# Incident response

What to do, in what order, using what the framework already records.

This is the operational counterpart to [threat-model.md](threat-model.md): that document
says what could go wrong, this one says what to do at 3am when it has.

- [Severity](#severity)
- [The first five minutes](#the-first-five-minutes)
- [Where the evidence is](#where-the-evidence-is)
- [Playbooks](#playbooks)
- [Containment reference](#containment-reference)
- [After](#after)
- [What the framework does not do](#what-the-framework-does-not-do)

---

## Severity

The framework's own severity levels map to how fast you have to move.

|              | Events                                                                                          | Response                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Critical** | `session.refresh_reuse_detected`, `authz.cross_tenant_blocked`, `authz.role_escalation_blocked` | Page someone. These mean an active compromise is likely.                   |
| **Warning**  | `auth.failed`, `api_key.auth_failed`, `abuse.rate_limited`                                      | Investigate in aggregate. One is noise; a hundred from one address is not. |
| **Info**     | `session.created`, `api_key.created`                                                            | Context during an investigation.                                           |

`critical` is reserved for events that mean an active compromise is likely — not for
anything merely unwanted. That is deliberate, so that an alert on `critical` is worth
waking somebody for. Critical events are also written directly to the application log,
in case a sink is misconfigured.

## The first five minutes

In this order, because the order matters:

1. **Contain before investigating.** Revoke the credential, revoke the session, disable
   the account. Every operation is idempotent and reversible in the sense that matters —
   a wrongly revoked key is a new key, a wrongly preserved key is an ongoing breach.
2. **Note the time and the decision id.** A 403 carries a `decisionId` that connects it
   to the exact policy that refused. A customer report of "an error at 14:12" becomes an
   exact record.
3. **Preserve evidence before cleaning up.** `SecurityEvent` rows and audit records are
   what the investigation runs on. Do not delete the compromised account — disable it,
   so its audit records stay resolvable.
4. **Then investigate.**

The reason containment comes first: every minute spent determining scope is a minute the
credential still works.

## Where the evidence is

| Question                                  | Where                                             |
| ----------------------------------------- | ------------------------------------------------- |
| What was attempted and refused?           | `SecurityEvent`                                   |
| Who changed which record?                 | `AuditLog` (with `actorType`)                     |
| Which sessions are open, on what devices? | `UserSession`                                     |
| Has this key been used, from where?       | `ApiKey.lastUsedAt` / `lastUsedIp` / `usageCount` |
| Which integration is this?                | `ServiceAccount`                                  |
| Why was this request refused?             | the `decisionId` in the 403 → `authz.denied`      |

```sql
-- Everything critical in the last day.
SELECT "occurredAt", type, reason, "actorId", "actorType", "ipAddress", context
FROM "SecurityEvent"
WHERE severity = 'critical' AND "occurredAt" > now() - interval '1 day'
ORDER BY "occurredAt" DESC;

-- Failed authentication grouped by source. `identifier` in the context is a
-- correlation hash, not an email address — comparable, not readable.
SELECT "ipAddress", count(*), min("occurredAt"), max("occurredAt")
FROM "SecurityEvent"
WHERE type = 'auth.failed' AND "occurredAt" > now() - interval '1 hour'
GROUP BY "ipAddress" ORDER BY count(*) DESC LIMIT 20;

-- What did this actor touch?
SELECT "createdAt", action, "entityType", "entityId", before, after
FROM "AuditLog" WHERE "actorId" = $1 ORDER BY "createdAt" DESC;
```

IP addresses on sessions are stored as `correlationHash(address, salt)`: two sessions
from the same address are comparable, and the address itself is not in the table. Compute
the hash of a suspected address with the same salt to search for it.

## Playbooks

### A leaked API key

Symptoms: the key appears in a public repository, a paste, a screenshot; or
`lastUsedIp` is somewhere unexpected.

1. **Revoke it.** `DELETE /security/api-keys/:id` with a reason.
2. **Then rotate**, if the integration needs to keep working. In that order — rotating
   first leaves the leaked key valid for the 24-hour grace period.
3. Scope the exposure: `usage()` gives `lastUsedAt`, `lastUsedIp` and `usageCount`.
   Compare against when the key leaked.
4. Query `api_key.auth_succeeded` events for that prefix and look for addresses that are
   not the integration's.
5. Reconstruct what was done: `AuditLog` where `actorId` is the key's id.
6. If the key had write scopes and was used from an unexpected address, treat the data it
   could reach as modified until proven otherwise.

### Refresh-token reuse detected

Symptoms: `session.refresh_reuse_detected`, critical.

The framework has already contained it: the family is revoked, the session is over. But
the event means **somebody had a copy of a refresh token**, which is not a false alarm.

1. Read the event's context: `sessionId`, `familyId`, `firstUsedAt`.
2. `SELECT * FROM "UserSession" WHERE "familyId" = $1` — what device, when created.
3. Compare `ipHash` on the session against the reuse attempt's address hash. Different
   hashes strongly suggest theft rather than a client bug.
4. Look for other sessions for that user from the same address hash.
5. Force a password change and revoke everything: `DELETE /security/sessions/mine` as
   the user, or `revokeAll` administratively.
6. Reconstruct the window between `firstUsedAt` and the detection from the audit trail.

A client bug — two tabs racing, a retry without cancelling the first request — presents
the same event. The address hash comparison is what distinguishes them.

### Credential stuffing

Symptoms: many `auth.failed` events, many identifiers, one or few addresses.

1. Block at the edge. The framework's rate limiter is process-local and will not stop a
   distributed attempt on its own.
2. Group `auth.failed` by `ipAddress` and by the hashed `identifier` in context. Many
   identifiers from one address is stuffing; one identifier from many addresses is
   targeted.
3. Check for any `auth.succeeded` from those addresses. Those accounts are compromised —
   revoke their sessions and force a password change.
4. Consider lowering `lockout.maxAttempts` temporarily.
5. Ask whether the compromised-password check would have caught it, and whether it is
   time to put a real corpus behind `CompromisedPasswordChecker`.

### Cross-tenant access attempt

Symptoms: `authz.cross_tenant_blocked`, critical.

This means a control **worked**. It is critical because a legitimate client does not
attempt it: something is either misconfigured or probing.

1. Identify the actor and the target organization from the event.
2. Look at the pattern. One event is likely a bug — a cached organization id, a
   hard-coded value in a test. Many events across many organizations is enumeration.
3. If it is a bug, fix the client. If it is probing, revoke the actor's credentials and
   review everything else they touched.
4. Either way, verify the boundary held: query the audit trail for that actor against
   the target organization and confirm there is nothing there.

### A compromised administrator account

The worst case, because the account's actions are indistinguishable from legitimate ones.

1. `revokeAll` for that user.
2. Force a password change; if MFA exists, require re-enrolment.
3. Revoke every credential they created: query `ApiKey` and `ServiceAccount` by
   `createdById`.
4. Review every role assignment they made: `AuditLog` where action starts with
   `rbac.role`.
5. Look for persistence: a new service account, a new API key with wide scopes, a role
   granted to another account. This is what an attacker does to survive the loss of the
   credential.
6. Only then investigate how the account was compromised.

Step 5 before step 6, because persistence mechanisms are what turn a contained incident
into a recurring one.

## Containment reference

```bash
# Revoke one API key.
curl -X DELETE "$API/security/api-keys/$ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"reason":"leaked in public repository"}'

# Disable a service account.
curl -X DELETE "$API/security/service-accounts/$ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"reason":"credential compromised"}'

# End one session.
curl -X DELETE "$API/security/sessions/$ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"reason":"suspicious"}'
```

Direct SQL, when the API is unavailable. Note what these do **not** achieve: an access
token already issued keeps working until it expires, because it is stateless.

```sql
UPDATE "ApiKey" SET "revokedAt" = now(), "revokedReason" = 'incident' WHERE id = $1;
UPDATE "UserSession" SET "revokedAt" = now(), "revokedReason" = 'administrative' WHERE "userId" = $1;
UPDATE "RefreshToken" SET "revokedAt" = now(), "revokedReason" = 'incident' WHERE "userId" = $1;
UPDATE "ServiceAccount" SET status = 'disabled' WHERE id = $1;

-- The one thing that does invalidate outstanding access tokens for a user, if the
-- application checks tokenVersion (the framework's TokenService does).
UPDATE "User" SET "tokenVersion" = "tokenVersion" + 1 WHERE id = $1;
```

## After

- **Write down the timeline** before memory decays: detection, containment, scope,
  resolution.
- **Add a test.** If a control failed, the fix is not complete until a test fails without
  it. If a control worked, consider whether a test proves it will keep working.
- **Ask which residual risk this was.** [threat-model.md](threat-model.md) names them and
  states the future control for each. An incident is evidence about which one to build.
- **Update the threat model** if the incident was something it does not name.
- **Notify** according to your own regulatory obligations. The framework records what
  happened; deciding who must be told is not something a framework can do.

## What the framework does not do

No alerting, no paging, no SIEM integration, no automated response. `SecurityEventSink`
is the interface — implement it to forward events wherever your alerting lives. The
`onSuspicious` hook on `SessionService` is where automated response would go.

Those are deliberately absent because they are deployment decisions: which channel,
which threshold, who is on call. The framework's job is to record the right events, in a
structured form, with nothing sensitive in them.

---

**See also:** [threat-model.md](threat-model.md) ·
[security-testing.md](security-testing.md) ·
[session-security.md](session-security.md) ·
[api-key-security.md](api-key-security.md)
