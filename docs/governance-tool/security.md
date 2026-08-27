# Governance Tool security

Read this before changing anything in `internal-app-gateway`, `governance-data-access`,
`governance-auth-context` or `governance-pii-policy`.

## The threat model

| Threat                     | Refused by                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Direct financial mutation  | Class B enforcement + no ledger path in any console or gateway operation                |
| Direct security mutation   | The same. Role changes are a _request_ through maker-checker                            |
| Frontend role manipulation | Permissions come from the membership lookup; the API authorizes again                   |
| Tenant leakage             | Tenant from the verified actor; no code path reads a header                             |
| Unsafe SQL                 | There is no query field to put SQL in                                                   |
| Environment crossover      | `assertNoCrossEnvironmentCredential`, refused at load                                   |
| Secret exposure            | Class C by name at three points; `credentialRef` is a reference                         |
| PII leakage                | Server-side masking; reveal is bounded, reasoned and audited                            |
| Unrestricted export        | Row ceilings by classification, justification floor, approval, watermark, expiry        |
| Mass extraction            | The row ceiling. Every incident looks like a legitimate export with the filters removed |
| Workflow bypass            | Approval state lives in the engine; views carry a version and stale ones are refused    |
| Audit bypass               | The bridge writes into the TrustOS trail, and refusals are audited too                  |
| AI tool abuse              | No return type carries an action; the input allow-list is per feature                   |
| AI data leakage            | Inputs are references resolved server-side under the actor's own permissions            |
| Production tampering       | Production is not editable; promotion needs evidence, review and a rollback target      |

## Identity

`normalizeActor` does one job and it is a refusal: **claims become an identity, never an
authorization.**

- `permissions` is `[]`, always.
- The organization comes from the server-side lookup. A token's `organization` claim is ignored,
  and there is no code path that reads one.
- Groups are **mapped explicitly**, with no fallback role. A `default` for unmapped groups is the
  single most tempting line in the file and turns "somebody was added to a group" into "somebody
  has the finance console".
- Unmapped groups are **reported**, so a provider that starts emitting `finance-team-v2` produces
  a visible gap rather than a silent loss — or gain — of access.
- Authentication strength is guessed **downward**. An unrecognised method reads as `password`, so
  the assurance guard is not fooled by a provider adding a method name nobody mapped.

## What the Governance Tool permissions are for

They decide **what renders**. That is the whole of it.

The rule, stated because it is what decays: **grant them generously, and never rely on them.** A
support agent who can see the freeze button and cannot freeze gets a clear refusal from the API.
One who cannot see the button but holds the API permission can still freeze, and should be able
to.

If they were the only check, hiding a button would be the control — and a button hidden in a
browser is a request anybody can still make with curl.

`GOVERNANCE_SEGREGATED_PAIRS` is exported as data so a deployment **asserts** the separation over
its seeded roles rather than describing it in a runbook.

## PII

**Masking is server-side.** A value that reaches the browser masked was masked before it left.
There is no client-side mask in this layer.

**A reveal is an event, not a state**: requester, reason (twenty characters minimum), subject,
fields, expiry (fifteen minutes, capped), audit record. It is not a permission somebody holds and
then has.

Two fields are **never revealable**: a government identifier and a date of birth. Both are
verified or matched rather than read, and a field nobody needs to read needs no reveal path.

A request for three fields where one is not revealable **returns the two and says why the third
was refused**. Refusing the whole request trains people to ask one field at a time, which
produces more reveals with less context in each audit record.

The audit record of a reveal carries **field names, never values**. An audit record of a reveal
must not itself be a reveal.

## Export

The one operation that produces data outside every control that produced it.

| Classification    | Max rows  | Approval above | Expiry |
| ----------------- | --------- | -------------- | ------ |
| public            | 1,000,000 | —              | 168h   |
| internal          | 100,000   | 50,000         | 72h    |
| confidential      | 25,000    | 5,000          | 24h    |
| restricted        | 5,000     | 500            | 8h     |
| highly_restricted | 100       | **1**          | 4h     |

Masking **survives the export**. A field masked on a screen and unmasked in the CSV is a control
that only worked while somebody was looking at it.

The watermark carries the actor id and the instant, and **not a name or an email** — a watermark
is read by whoever found the file, and that is not necessarily somebody entitled to the
exporter's identity.

## AI

Ten features, all summarize, explain or draft. **None acts**, and that is enforced by shape: the
output type is text plus provenance. There is no field naming an operation and no path from an
output to the gateway.

The control that does unexpected work is the **per-feature input allow-list**. A summarizer
becomes a data-exfiltration path when somebody widens its inputs "so it has more context" — so
`summarize_case` takes the case, and not the customer's full record.

The gateway request runs as the **actor**, not the application. Tool permissions are validated
against the actor, not the agent — phase 7's rule, and the one that makes a successful prompt
injection survivable.

Three refusals on using an output: a blocked guardrail means it is **not used** (not shown with a
warning — a warning is read once), a truncated run is **not a final answer**, and a feature that
needs review is not usable until somebody reviews it.

## Environments

**A lower-environment credential must never authenticate to production.** It is violated the same
way every time: somebody copies a `.env` to debug something and it _works_, so nobody notices
until an export.

`assertNoCrossEnvironmentCredential` refuses a shared credential reference **at load** rather than
at first use — by first use it has already worked once, and a thing that works is depended on by
the afternoon.

Promotion refuses a **skip** (DEV to PROD misses the stage where somebody would have used it), a
**demotion** (which replaces the running console with whatever was in UAT), a missing rollback
target, missing test evidence, and an unregistered resource in the _target_ environment.

## What this layer does not defend against

- **A compromised TrustOS API.** The gateway routes to it; it does not second-guess it.
- **A malicious approver.** Maker-checker ensures two people, not two honest people.
- **A deployment's own forwarder.** If it forwards with a service credential rather than the
  actor's, everybody has the gateway's permissions. The framework ships no forwarder and says so
  at start-up.
- **An unregistered resource reached outside the gateway.** Nothing here can stop code that does
  not call it. The control is that internal applications are documents, and a document cannot
  contain a connection string.
