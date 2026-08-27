# Audit

Governance Tool actions are audited **into the TrustOS audit trail**, not into a trail of their
own. Two trails means two answers to "what happened", and during an investigation somebody has to
decide which is right.

## What the bridge adds

A TrustOS record says:

> `usr_7` froze wallet `wlt_3`.

With the bridge it says:

> `usr_7` froze wallet `wlt_3` **from the customer support console, in production, because of
> case `cas_9`, under approval `apr_2`, correlated to `req_abc`**.

The second sentence is the one an investigation can act on.

This required extending `@trustos/audit` with a `metadata` column — provenance is not state, and
putting it in `after` would have meant `after` no longer means "state after the change". The
migration is `20261201000000_audit_metadata`, nullable, with no backfill: a guessed audit record
is worse than an absent field.

## Refusals are audited

The step most systems omit. A trail of successful reads answers "what did they see" and **not**
"what did they try" — and the second is the question an investigation opens with.

`governance.data.read_refused`, `governance.mutation.refused`, `governance.pii.reveal_refused`
and `governance.export.refused` are written on the failure path, before the error propagates.

## Action names are specific

An auditor searching for reveals searches for `governance.pii.revealed`. A generic
`governance.action` would mean reading every record and inspecting its metadata — which they will
not do; they will search for a name that does not exist and conclude nothing happened.

| Group        | Actions                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Applications | `app.opened` `app.created` `app.updated` `app.submitted` `app.approved` `app.promoted` `app.retired` |
| Resources    | `resource.registered` `resource.approved` `resource.revoked`                                         |
| Data         | `data.read` `data.read_refused` `mutation.requested` `mutation.refused`                              |
| PII          | `pii.reveal_requested` `pii.revealed` `pii.reveal_refused`                                           |
| Export       | `export.requested` `export.approved` `export.produced` `export.refused`                              |
| AI           | `ai.assist_requested` `ai.output_reviewed`                                                           |

## What never reaches an audit record

- A credential, in any field. `metadata` is redacted exactly as `before` and `after` are.
- The **values** of a reveal. Field names and a reason; an audit record of a reveal must not
  itself be a reveal.
- The **contents** of an export. Field names, a row count, the justification.
- An AI **prompt or completion**.

## A limitation worth knowing

`AuditService.record` **does not throw** when its sink is unavailable. It logs at error level and
returns, so a sink outage degrades the trail rather than taking the platform down. That is phase
1's decision and this bridge inherits it.

The consequence: a missing audit record does not fail the action, and nobody retries a missing
record because nobody knows it is missing. The compensating control is the error log — a
deployment that cares alerts on `audit record could not be written`, which is the exact message
`AuditService` emits.

## Immutability

`AuditSink` has no `update` and no `delete`, and neither does the bridge. The database grant is
the control:

```sql
GRANT SELECT, INSERT ON "AuditLog" TO trustos_app;
REVOKE UPDATE, DELETE ON "AuditLog" FROM trustos_app;
```

Neither application exposes a `DELETE` route at all, and both boot tests assert it.
