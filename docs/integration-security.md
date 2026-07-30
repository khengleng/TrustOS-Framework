# Integration security

The integration layer is where this platform accepts input from outside, makes requests to outside,
and hands data to outside. Every one of those is a boundary, and this is what defends each.

- [The attacks this layer faces](#the-attacks-this-layer-faces)
- [Server-side request forgery](#server-side-request-forgery)
- [Replay](#replay)
- [Signature forgery](#signature-forgery)
- [Duplicate delivery](#duplicate-delivery)
- [Tenant leakage](#tenant-leakage)
- [Spreadsheet formula injection](#spreadsheet-formula-injection)
- [Resource exhaustion](#resource-exhaustion)
- [Secrets](#secrets)
- [What is not defended](#what-is-not-defended)

---

## The attacks this layer faces

| Attack                          | Defence                                                 | Where                            |
| ------------------------------- | ------------------------------------------------------- | -------------------------------- |
| SSRF via a webhook URL          | DNS resolution, private-range denial, no redirects      | `webhook-runtime/destination.ts` |
| Replayed webhook delivery       | Timestamp inside the signed payload, five-minute window | `webhooks/signature.ts`          |
| Forged signature                | HMAC-SHA256, constant-time comparison                   | `webhooks/signature.ts`          |
| Duplicate delivery              | Unique index on `(endpoint, event)`                     | Migration, `webhook_delivery`    |
| Duplicate job                   | Partial unique index on `idempotencyKey`                | Migration, `job`                 |
| Cross-tenant event delivery     | Bus-enforced subscription scope                         | `event-bus/in-memory-bus.ts`     |
| Cross-tenant export             | Mandatory `organizationId` on every source call         | `export/export-service.ts`       |
| Formula injection in an export  | `'` prefix on `= + - @`                                 | `export/formats.ts`              |
| Unbounded import                | Row, column, cell and byte limits                       | `import/parsers.ts`              |
| Unbounded response body         | 4 KB cap, read incrementally                            | `webhook-runtime/delivery.ts`    |
| Unbounded event                 | 256 KiB serialization limit                             | `event-sdk/serialization.ts`     |
| Secret in an event or log       | Name-based redaction before storage or delivery         | `event-sdk/serialization.ts`     |
| Secret at rest                  | AES-256-GCM with a fresh IV                             | `webhooks/secrets.ts`            |
| Unregistered event              | Registry validation at publish                          | `event-registry/registry.ts`     |
| Catastrophic regex backtracking | Segment-walking pattern matcher, no regex compilation   | `event-sdk/pattern.ts`           |

## Server-side request forgery

The most serious issue in this phase, because the feature _is_ the vulnerability: a webhook URL is
attacker-controlled input that the server then makes a request to.

The concrete attack is registering `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
and reading the response out of the delivery log through the admin API.

Four checks, and the order matters:

1. **Resolve DNS first.** A hostname check is useless — `evil.com` can hold an A record for
   `10.0.0.1`, and the string check passes while the request goes to the internal network.
2. **Check every resolved address.** One public and one private A record would otherwise pass
   whenever the resolver ordered the public one first, which is roughly half the time — an
   intermittent bug is much harder to find than a consistent one.
3. **Unwrap IPv4-mapped IPv6.** `::ffff:10.0.0.1` is a route to `10.0.0.1`. Both spellings, because
   the WHATWG URL parser normalizes the readable one into hex: `new URL('https://[::ffff:10.0.0.1]/')`
   reports `[::ffff:a00:1]`, and a check that only matched the dotted form would pass every such URL.
4. **Never follow a redirect.** A `302 → http://10.0.0.1` bypasses all three, because they ran
   before the request went out.

Blocked ranges: loopback, link-local (including instance metadata), all RFC 1918 private ranges,
carrier-grade NAT, multicast, reserved, and the IPv6 equivalents.

## Replay

A captured webhook delivery must not be replayable forever.

The defence is that **the timestamp is inside the signed payload**: `HMAC(secret, "${timestamp}.${body}")`.
Signing only the body would leave a captured request valid indefinitely, because the body does not
change. Signing both means changing the timestamp breaks the signature, so a receiver can reject
anything older than its tolerance _and know the timestamp is authentic_.

Five minutes by default, in both directions. A future timestamp is rejected too: without that, a
forged far-future timestamp would never expire.

The framework's own event deduplication is a separate mechanism — see below — because a replay from
outside and a redelivery from inside are different problems.

## Signature forgery

HMAC-SHA256 over `${timestamp}.${body}`, hex-encoded, compared with `timingSafeEqual`.

`===` on a signature leaks, through timing, how many leading bytes were right — a practical attack
given enough requests. The comparison also does the work even on a length mismatch, so a
wrong-length signature does not return measurably faster than a right-length wrong one.

Verification checks **every** candidate secret with no early exit, so which secret matched does not
leak through timing during a rotation.

## Duplicate delivery

"Never send duplicate webhook deliveries" is only true if two application instances handling the
same event cannot both succeed. It is a **unique index on `(webhookEndpointId, eventId)`**, not a
check-then-insert — which loses that race precisely under the load where it matters.

Same shape for jobs: a partial unique index over non-terminal rows, with `COALESCE(organizationId, '')`
because PostgreSQL treats NULLs as distinct and two platform jobs with one key would otherwise both
be allowed.

Verified against real PostgreSQL, not asserted.

## Tenant leakage

The worst available outcome in this phase, and it is defended structurally rather than by care:

- **Every store method takes `organizationId` explicitly.** Not from ambient context. A method
  without the parameter is a compile error rather than a query that returns everybody's rows.
- **`null` means platform scope**, and the type is `string | null` rather than optional — so a
  caller cannot omit it and get the platform's view by accident.
- **The bus scopes subscriptions itself.** A tenant-scoped subscriber never sees another tenant's
  event, and never sees a platform event either: a tenant handler receiving an event with no tenant
  has nothing to scope its work to.
- **Cross-tenant reads report not-found, not forbidden.** "Forbidden" confirms the record exists,
  which tells an unauthorized caller something about another tenant's data.

## Spreadsheet formula injection

A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is a **formula** to Excel, LibreOffice
and Google Sheets. `=cmd|' /C calc'!A0` in an exported cell executes when the file is opened.

The data came from a user — a customer name, a note field — so this is a stored injection whose
payload runs on the machine of whoever opens the export. The fix is a `'` prefix, which
spreadsheets read as "this is text".

It is visible in the cell, and that is the trade: a leading apostrophe on a value that genuinely
starts with `-` is mildly wrong; executing a formula is catastrophically wrong.

The import side flags such cells rather than rejecting them — a legitimate value can start with `-`
— and the CSV error report escapes them, because an error report is the one file guaranteed to be
opened in a spreadsheet.

## Resource exhaustion

Every boundary is bounded, and each bound exists because the unbounded version is a denial of
service an authenticated user can trigger:

| Bound                 | Value                                             | Without it                                                       |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Event serialization   | 256 KiB                                           | A file smuggled through the bus into every queue and dead letter |
| Import file           | 50 MB, 100k rows, 200 columns, 10k chars per cell | An out-of-memory crash on upload                                 |
| Export rows           | 1,000,000, paged                                  | Reading the whole database through a spreadsheet feature         |
| Webhook response body | 4 KB, read incrementally then abandoned           | A receiver exhausting the _sender's_ memory                      |
| Redaction depth       | 8 levels, cycle-safe                              | A stack overflow from a nested payload                           |
| Stored import errors  | 500 (the count stays exact)                       | A 100k-row file with a wrong header producing 100k rows of error |
| Event pattern         | Segment walk, no regex                            | Catastrophic backtracking from a subscription request            |

## Secrets

- **Webhook signing secrets are encrypted at rest** with AES-256-GCM and a **fresh IV per
  encryption**. IV reuse with GCM is catastrophic rather than weak: it leaks the XOR of the
  plaintexts and allows forging the authentication tag.
- **Encryption, not hashing**, because signing needs the secret back. That makes the encryption key
  the thing that matters, and it belongs somewhere better than the same database as the ciphertext —
  `SecretCipher` is the port for moving it into KMS or Vault.
- **A secret is shown exactly once**, at creation and at rotation. There is no read endpoint,
  because one is indistinguishable from an exfiltration endpoint to anybody who has stolen a
  session.
- **Audit records carry hints, never values.** An audit trail is read by more people and kept in
  more places than a secret store is.
- **Events are redacted before delivery and before dead-lettering.** A webhook body leaves the trust
  boundary entirely and is in a third party's logs within seconds.

## What is not defended

Stated because an undocumented limit is one people over-trust:

- **DNS rebinding.** The address can change between the destination check and the connection.
  Closing it needs the resolved address pinned into the socket, which Node's fetch does not expose.
  A deployment in a sensitive network should put an egress proxy in front of the webhook worker.
- **A compromised database.** Every constraint here is enforced by PostgreSQL. Somebody with
  superuser access can drop an index. These are controls against application bugs and a compromised
  application role.
- **A malicious job handler or provider.** Both run in-process with full application privileges.
  There is no sandbox, and the module catalog's review is the control.
- **Malware in an uploaded import file.** Out of scope for this phase, as it was for phase 5.
- **Timing side channels other than signature comparison.** Only that one is hardened.

---

**See also:** [webhooks.md](webhooks.md) · [events.md](events.md) ·
[integration-architecture.md](integration-architecture.md) · [security.md](security.md)
