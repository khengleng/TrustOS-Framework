# DNS — trustos.cambobia.com

The custom domain is already attached to the Railway service. What remains is one DNS record,
which has to be added in the zone's own provider. This file records the values Railway
returned, where they go, and how to check the result.

## The record

Railway returned this after the domain was attached. It is not an example — it is the value
for this domain, and it will not work for another one.

```
Type:   CNAME
Name:   trustos
Target: w5sb6cy3.up.railway.app
TTL:    300
```

Some providers want the name fully qualified (`trustos.cambobia.com`) and some want a trailing
dot on the target (`w5sb6cy3.up.railway.app.`). Google Cloud DNS wants both.

## Where it goes

`cambobia.com` is **not** on Cloudflare. Checked:

```
$ dig +short NS cambobia.com
ns-cloud-e1.googledomains.com.
ns-cloud-e2.googledomains.com.
ns-cloud-e3.googledomains.com.
ns-cloud-e4.googledomains.com.
```

The zone is hosted in **Google Cloud DNS**. The apex still points at Squarespace
(`198.185.159.144/145`, `198.49.23.144/145`), so the website and the DNS are managed in
different places — the record below has to be added where the nameservers are, which is Google
Cloud DNS, not the Squarespace dashboard.

There is already a precedent in this zone: `www.cambobia.com` is a CNAME to
`jxxsjalb.up.railway.app`, another Railway service. The record for `trustos` is the same shape
pointing at a different target.

### Google Cloud DNS

Console → Network Services → Cloud DNS → the `cambobia.com` zone → **Add standard**:

| Field                | Value                                            |
| -------------------- | ------------------------------------------------ |
| DNS name             | `trustos` (the console appends `.cambobia.com.`) |
| Resource record type | `CNAME`                                          |
| TTL                  | `300` seconds                                    |
| Canonical name       | `w5sb6cy3.up.railway.app.`                       |

Or with `gcloud`, substituting the real zone name:

```bash
gcloud dns record-sets create trustos.cambobia.com. \
  --zone=<zone-name> \
  --type=CNAME \
  --ttl=300 \
  --rrdatas=w5sb6cy3.up.railway.app.
```

## Ownership verification

Railway also returned an ownership token:

```
Host:  _railway-verify.trustos
Type:  TXT
Value: railway-verify=71f30a96bd302b471c6006dfcd41238484e6664bcc28bfb2388ae872c99e96ef
```

This is **not** normally needed. Railway lists exactly one required record — the CNAME above,
with purpose `TRAFFIC_ROUTE` — and issues the certificate once that resolves. The TXT is for
proving ownership ahead of pointing traffic, or where a CNAME cannot be used. Add the CNAME
first; only add the TXT if Railway asks for it.

## Verifying

`trustos.cambobia.com` currently returns `NXDOMAIN`, which is the expected state before the
record exists.

```bash
# 1. the record resolves, and resolves to Railway
dig +short trustos.cambobia.com
# expect: w5sb6cy3.up.railway.app. followed by an IP

# 2. Railway agrees the domain is verified
railway domain --service governance-tool --json

# 3. TLS — the certificate must name the custom domain, not the Railway one
openssl s_client -connect trustos.cambobia.com:443 -servername trustos.cambobia.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates

# 4. the service answers on it
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://trustos.cambobia.com/health
curl -sS https://trustos.cambobia.com/health
```

Certificate issuance is usually a minute or two after the record propagates, and it cannot
start before that — Railway validates ownership over the resolved name.

## Verified

Both records were added in Google Cloud DNS on 2026-08-28 — the CNAME and, though Railway did
not require it, the ownership TXT. Results:

```
$ dig +short trustos.cambobia.com
w5sb6cy3.up.railway.app.
69.46.46.85

$ dig +short TXT _railway-verify.trustos.cambobia.com
"railway-verify=71f30a96…e96ef"

$ openssl s_client -connect trustos.cambobia.com:443 -servername trustos.cambobia.com
subject=CN=trustos.cambobia.com
issuer=C=US, O=Let's Encrypt, CN=YE2
notBefore=Aug 28 03:00:47 2026 GMT
notAfter=Nov 26 03:00:46 2026 GMT
X509v3 Subject Alternative Name: DNS:trustos.cambobia.com
```

| Check                                       | Result                                      |
| ------------------------------------------- | ------------------------------------------- |
| DNS resolves to the required target         | yes                                         |
| Certificate names the custom domain         | yes — SAN is exactly `trustos.cambobia.com` |
| `https://trustos.cambobia.com/health`       | `200`                                       |
| `https://trustos.cambobia.com/ready`        | `200`, database check passing               |
| `http://` → `https://`                      | `301`, to the custom domain                 |
| Redirect to localhost or a Railway hostname | none                                        |

Routing came up about a minute before the certificate did. In between, the domain answered
`200` on `/health` while still presenting the `*.up.railway.app` certificate — so a check that
ignores certificate errors can report success while a browser still shows a warning. Verify
the SAN, not just the status code.

## Cloudflare

Not applicable today; kept because the zone could move.

If `cambobia.com` is ever moved behind Cloudflare, add the same CNAME with **Proxy status: DNS
only** (grey cloud) while Railway issues its certificate — an orange-cloud record hides the
origin from Railway's validator and issuance never completes. Once
`railway domain` reports the domain verified and HTTPS works end to end, proxying can be
enabled, and then Cloudflare's SSL/TLS mode must be **Full (strict)**. "Flexible" terminates
TLS at Cloudflare and speaks plain HTTP to Railway, which both breaks the end-to-end
requirement and, with Railway's own HTTP-to-HTTPS redirect, produces a redirect loop.

## Troubleshooting

| Symptom                                     | Cause                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NXDOMAIN` after adding the record          | Not propagated yet, or added to a zone whose nameservers are not the authoritative ones. Check `dig +short NS cambobia.com` against where you added it.                                                                                                            |
| Resolves, but Railway still says unverified | Give it a few minutes. Confirm the target is exactly `w5sb6cy3.up.railway.app` — a different Railway service's target will resolve and still never verify.                                                                                                         |
| Certificate warning                         | Issuance has not finished, or the CNAME points at the Railway-generated domain of the service (`governance-tool-production.up.railway.app`) instead of the target Railway returned for the custom domain. Those are different hostnames and only the latter works. |
| Redirect loop                               | Cloudflare proxy on with SSL/TLS mode "Flexible". Use Full (strict).                                                                                                                                                                                               |
| `404` with a JSON body at the root          | Expected. See the assessment: no web interface is deployed yet. `/health` is the endpoint to test with.                                                                                                                                                            |
