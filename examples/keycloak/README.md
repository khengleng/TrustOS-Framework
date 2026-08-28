# Keycloak for local development

A reproducible Keycloak for developing against `IDENTITY_PROVIDER=oidc`. Not a
production deployment, and not something TrustOS installs for you — running an
identity provider is an infrastructure decision with its own backup, upgrade and
availability story.

## Start it

```bash
cd examples/keycloak
cp .env.example .env
# Edit .env. It ships with empty passwords and compose refuses to start without them.
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

docker compose up -d
```

Admin console: <http://localhost:8080/admin> · Issuer:
<http://localhost:8080/realms/trustos-dev>

## Point an application at it

```bash
IDENTITY_PROVIDER=oidc
OIDC_ISSUER_URL=http://localhost:8080/realms/trustos-dev
OIDC_CLIENT_ID=trustos-api
OIDC_CLIENT_SECRET=      # from the admin console; see below
OIDC_ROLE_MAP={"trustos-organization-owner":"organization_owner","trustos-administrator":"administrator","trustos-operator":"operator","trustos-auditor":"auditor"}
```

## Two things you have to do by hand, on purpose

**Set the test users' passwords.** `realm-trustos-dev.json` defines
`owner@acme.test` and `operator@acme.test` with no credential. Set one in the admin
console (Users → Credentials → Set password, leave "Temporary" on). The file contains
no password because a file in a repository that contains a working password is a
committed credential, however development-only the realm is.

**Read the API client secret.** Clients → `trustos-api` → Credentials → Client
secret. Keycloak generates it on import; copy it into your `.env`. Same reason.

## What the realm defines

|                  |                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trustos-web`    | Public client. Authorization code + **PKCE S256, required**. Redirects to `localhost:3000/3001`. Has an audience mapper adding `trustos-api` to `aud`.      |
| `trustos-api`    | Confidential client. Service accounts enabled for the client-credentials grant.                                                                             |
| `ledger-sync`    | An example machine client, so the service-account path is exercisable without hand-creating one.                                                            |
| Realm roles      | `trustos-organization-owner`, `-administrator`, `-operator`, `-auditor` — mapped to TrustOS roles via `OIDC_ROLE_MAP`.                                      |
| Groups           | `acme-owners`, `acme-operators`, each carrying a `trustos_organization` attribute.                                                                          |
| Token lifetimes  | 15-minute access token, matching `tokens.accessTokenSeconds`, so you do not debug a mismatch between the issuer and the application.                        |
| Refresh rotation | `revokeRefreshToken: true`, `refreshTokenMaxReuse: 0` — Keycloak's own reuse detection, on in development too, because untested behaviour is not behaviour. |
| Brute force      | Enabled, 10 failures, 15-minute cap. Independent of the framework's lockout, which only covers the local provider.                                          |

### The audience mapper

Without it, the access token issued to `trustos-web` has `aud: ["account"]` and the
API correctly refuses it. This is the most common first-hour failure when wiring
Keycloak to a separate API, and it looks like a broken framework rather than a missing
mapper — which is why it is in the export.

## After editing the realm file

```bash
./import-realm.sh          # applies changes to a running instance
docker compose down -v && docker compose up -d   # or start over from scratch
```

`import-realm.sh` passes the admin password on stdin so it does not appear in the
container's process list or your shell history.

## Not for production

`start-dev` disables HTTPS enforcement and clustering. A production Keycloak uses
`start`, with `KC_HOSTNAME` set to its public domain, TLS terminated at the edge, its
own Postgres with backups, and the admin console not publicly reachable. The
production checklist is in
[docs/enterprise-identity.md](../../docs/enterprise-identity.md#production-checklist).

`.env` is gitignored. Keep it that way.
