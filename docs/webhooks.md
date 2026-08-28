# Webhooks

Outbound HTTP delivery of events to somebody else's server. Signed, retried, deduplicated, and
checked against a destination policy before every attempt.

- [For integrators: verifying a delivery](#for-integrators-verifying-a-delivery)
- [Registering an endpoint](#registering-an-endpoint)
- [Rotating a secret](#rotating-a-secret)
- [Delivery, retry and giving up](#delivery-retry-and-giving-up)
- [Why a URL is not just a URL](#why-a-url-is-not-just-a-url)
- [Debugging "we never got it"](#debugging-we-never-got-it)

---

## For integrators: verifying a delivery

Every delivery carries these headers:

```
POST /your/endpoint HTTP/1.1
Content-Type: application/json
X-TrustOS-Signature: t=1756713600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
X-TrustOS-Timestamp: 1756713600
X-TrustOS-Event: merchant.onboarded
X-TrustOS-Delivery: whdl_01HZ...
```

Verification, in full:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const parts = new Map(header.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = Number.parseInt(parts.get('t') ?? '', 10);
  const provided = parts.get('v1');
  if (!Number.isFinite(timestamp) || !provided) return false;

  // Reject anything older than five minutes. This is what stops a captured request being
  // replayed forever, and it works because the timestamp is inside the signed payload.
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**`rawBody` must be the exact bytes received.** Not the parsed object, and not a re-serialization
of it. `JSON.parse` followed by `JSON.stringify` can reorder keys, change number formatting and
alter unicode escapes, and any of those changes the hash. This is the single most common reason a
correct implementation reports every signature as invalid.

In Express: `express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } })`.
In NestJS: `app.use(express.json({ verify: ... }))` before any other body parser.

**Deduplicate on `X-TrustOS-Delivery`.** It is stable across retries of the same delivery. Store
it and ignore repeats — that is where exactly-once processing is actually implementable.

Respond **2xx** as soon as you have durably accepted the event. Do the work afterwards. A receiver
that processes synchronously and takes twelve seconds will be retried while it is still working.

Respond **410 Gone** to stop receiving. The endpoint is disabled immediately rather than retried.

## Registering an endpoint

```bash
POST /webhooks/endpoints
{
  "url": "https://partner.example.com/hooks/trustos",
  "description": "Partner settlement notifications",
  "events": ["merchant.onboarded", "workflow.instance.completed"]
}
```

The response contains the signing secret. **Once.** There is no endpoint that returns it again,
because one is indistinguishable from an exfiltration endpoint to anybody who has stolen a session.
Store it when you see it.

HTTPS is required outside `localhost`. Over HTTP the payload is readable and the signature is
replayable by anybody on the network path.

A subscription to an event nobody publishes is refused. The symptom otherwise is silence — an
integrator waiting for `user.create` that will never arrive.

## Rotating a secret

```bash
POST /webhooks/endpoints/whep_01HZ.../rotate-secret
{ "graceMs": 86400000 }
```

Both secrets sign every delivery until the grace period ends, so the header carries two `v1=`
values and a receiver that has updated _and_ one that has not both verify successfully.

A rotation that cut over instantly would break every receiver at the same moment — which in
practice means nobody rotates and the secret from 2019 is still live.

For a **leaked** secret, revoke rather than rotate. Revocation is immediate and will break a
receiver still using it; that is correct, because a leaked secret lets anybody forge deliveries to
that endpoint.

## Delivery, retry and giving up

Eight attempts over roughly an hour, with exponential backoff and full jitter. What is retried:

| Response                    | Retried | Why                                                     |
| --------------------------- | ------- | ------------------------------------------------------- |
| 2xx                         | —       | Success                                                 |
| 408, 425, 429               | yes     | "Not now", not "not ever"                               |
| 5xx                         | yes     | Their problem, probably temporary                       |
| Other 4xx                   | **no**  | They understood and refused. Retrying fills their logs. |
| 3xx                         | **no**  | Redirects are not followed — see below                  |
| 410                         | **no**  | An explicit stop. The endpoint is disabled.             |
| Timeout, connection failure | yes     | Exactly what retry is for                               |

The body is built once, at queue time, and stored. Every retry sends the same bytes with the same
signature — rebuilding it would give the receiver a different signature for what they see as one
delivery.

An endpoint that fails 20 consecutive deliveries is **disabled automatically**. It is not coming
back on its own, and continuing wastes the sender's capacity and fills the receiver's logs.
Re-enabling clears the counter, so a fixed endpoint does not immediately disable itself again.

## Why a URL is not just a URL

A webhook URL is attacker-controlled input that the server then makes a request to. That is
server-side request forgery by construction.

The concrete attack: register `http://169.254.169.254/latest/meta-data/` — the cloud instance
metadata service — and the response body lands in the delivery log, readable through the admin API.
On an unpatched IMDSv1 host that response contains credentials.

So, before every attempt:

1. **DNS is resolved and every address checked.** Checking the hostname string is useless:
   `evil.com` can hold an A record for `10.0.0.1`.
2. **Every** resolved address, not just the first. One public and one private A record would
   otherwise pass about half the time, which is far harder to find than a consistent bug.
3. **Redirects are not followed.** A `302 → http://10.0.0.1` would bypass everything above,
   because the check happened before the request went out.
4. **The response body is capped** at 4 KB, read incrementally and then abandoned. An unbounded
   response is a denial of service against the _sender_.

What remains open, stated plainly because an undocumented limit is one people over-trust: **DNS
rebinding**. The address can change between the check and the connection. Closing it properly needs
the resolved address pinned into the socket, which Node's fetch does not expose. A deployment in a
sensitive network should put an egress proxy in front of this.

## Debugging "we never got it"

```bash
trustos doctor integrations          # is the worker even running?
GET /webhooks/deliveries?eventName=merchant.onboarded
GET /webhooks/deliveries/whdl_01HZ.../attempts
```

The attempt log is per attempt, not per delivery: "we tried at 10:00 and got a 502, at 10:01 and
got a 502, at 10:04 and it timed out" is the answer to the question. A single row holding only the
last attempt is not.

The usual causes, in order of how often they turn out to be it:

1. **No worker process is running.** Deliveries queue and nothing sends them. `doctor
integrations` warns about this.
2. **The receiver verifies against a re-serialized body.** Every signature invalid, every delivery
   a 401.
3. **The endpoint is disabled**, from an earlier outage nobody noticed.
4. **The subscription pattern does not match.** `workflow.task` does not match
   `workflow.task.assigned`.

---

**See also:** [events.md](events.md) · [integration-security.md](integration-security.md) ·
[integration-architecture.md](integration-architecture.md)
