# Operating the Governance Tool

## Onboarding an internal application

1. **Start from a template.** `POST /governance/apps/from-template` — always a draft, always in
   DEV, owned by whoever asked. A template that could be created directly into production would
   be a way to put a console in front of production data without passing the promotion that
   reviews it.
2. **Register its resources.** Every data source and every action names a resource id, and an
   unregistered one is refused at read time with "no approved resource". Register in DEV first.
3. **Check the access summary.** `GET /governance/apps/:appId/access` derives, from the
   definition, every resource the app reaches and its class. This is the screen a security
   reviewer opens.
4. **Fix what it reports.** An `unregistered` entry means the console will fail; a Class B
   mutation means an approval path exists and should be exercised.
5. **Submit, and have somebody else approve.** No role holds both `app.submit` and `app.approve`.

## Registering a resource

The fields that get it refused:

| Refusal                                           | Fix                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Exposes a Class C field                           | Remove it, or name it in `fieldExceptions` if it is a false positive |
| Class A declaring a mutation                      | It is not Class A. Its credentials can write                         |
| Class C listing fields                            | A Class C resource exposes nothing                                   |
| Production approved with no approver              | Record who approved it                                               |
| Registrant approved their own production resource | Somebody else approves                                               |

`credentialRef` is a **reference**. There is no field a secret could be pasted into.

## Promoting to production

```
GET  /governance/apps/:appId/access          # against the TARGET environment
POST /governance/apps/:appId/promotion/plan  # writes nothing
```

The plan refuses a skip, a demotion, an unregistered resource in the target, missing test
evidence, a missing security review and a missing rollback target. Fix all of them; there is no
override.

There is **no route that applies a plan**. Promotion is a deployment.

## Handling a reveal request

A support agent asks to see a customer's phone number.

1. They supply a reason of at least twenty characters. The SDK refuses a short one **before** the
   round trip, so it prompts rather than trains them to type twenty characters of nothing.
2. Non-revealable fields are refused individually and the rest are granted — the request is
   narrowed, not rejected whole.
3. A field marked `revealRequiresApproval` (card number, IBAN, address) waits for a second person.
4. The grant lasts **fifteen minutes**, capped. Check `assertRevealLive` on every read, not once
   at grant.
5. It is audited with the field **names**, the reason and the case reference.

If somebody asks for a longer window: the answer is no, and the reason is that "for the session"
always becomes a standing grant.

## Handling an export request

1. The requester supplies a justification. `estimatedRows` is counted **before** the export runs.
2. Above the classification's threshold, a second person approves.
3. Masking survives the file. The watermark carries the actor id and the instant.
4. The link expires — four hours for highly-restricted data, a week for public.

When an export is refused for the row ceiling, the fix is to narrow the query. Every
mass-extraction incident looks like a legitimate export with the filters removed.

## Troubleshooting

| Symptom                                                   | Cause                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "No approved resource" on every read                      | Nothing is registered. The default registry is empty by design                                      |
| A page is missing from the navigation                     | The actor lacks its permission. Pages are omitted, not disabled                                     |
| A button is disabled with a reason                        | The Governance Tool permission is missing. The API may still allow it                               |
| "This is the dev version and the runtime is serving prod" | The app was not promoted; do not point it at another environment's resources                        |
| "somebody else has acted on it" on an approval            | The view is stale. Reload and look again — do not retry                                             |
| Nothing in the audit trail                                | Check the logs for `audit record could not be written`. `AuditService` degrades rather than failing |

## What to alert on

- `audit record could not be written` — the trail is degrading silently.
- A rising count of `governance.data.read_refused` from one actor — either a misconfigured
  console or somebody probing.
- Any `governance.pii.revealed` outside business hours, or without a `caseRef`.
- `governance.export.produced` above a row count your operation does not normally need.
- Unmapped groups from `normalizeActor` — the directory has changed and somebody is losing access.
