#!/usr/bin/env bash
#
# Configures the DEV validation client in Keycloak, then hands its secret to Railway.
#
#   bash scripts/operator/configure-dev-validation-client.sh
#
# Run by an operator, on their own machine. The Keycloak administrator credential is
# read from the Railway service that already holds it and is never printed, never
# written to a file, and never leaves this process. The client secret goes straight
# from Keycloak into a Railway variable through a pipe — it is not echoed either.
#
# Everything here is scoped to the `trustos-dev` realm. The `trustos` realm that serves
# production is never addressed.
set -euo pipefail

REALM="trustos-dev"
KC="https://id.cambobia.com"
CLIENT_ID="trustos-foundation-validator"
AUDIENCE="trustos-api"
PORTAL="https://governance-tool-dev.up.railway.app"

say() { printf '  %s\n' "$*"; }

say "reading the Keycloak administrator credential from Railway (not printed)"
KCU="$(railway variables -s keycloak -e production --kv | sed -n 's/^KC_BOOTSTRAP_ADMIN_USERNAME=//p')"
KCP="$(railway variables -s keycloak -e production --kv | sed -n 's/^KC_BOOTSTRAP_ADMIN_PASSWORD=//p')"
[ -n "$KCU" ] && [ -n "$KCP" ] || { echo "could not read the admin credential"; exit 1; }

TOKEN="$(curl -sf -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$KCU" --data-urlencode "password=$KCP" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
unset KCU KCP
say "admin token obtained"

api() { curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# --- 1. the validation client -------------------------------------------------
UUID="$(api "$KC/admin/realms/$REALM/clients?clientId=$CLIENT_ID" \
  | python3 -c 'import sys,json;c=json.load(sys.stdin);print(c[0]["id"] if c else "")')"
[ -n "$UUID" ] || { echo "client $CLIENT_ID not found in realm $REALM"; exit 1; }
say "found $CLIENT_ID"

# Read, amend, write back — so nothing the client already has is silently dropped.
api "$KC/admin/realms/$REALM/clients/$UUID" > /tmp/kc-client.json
python3 - <<'PY' > /tmp/kc-client-new.json
import json
c = json.load(open('/tmp/kc-client.json'))
c.update({
    'publicClient': False,          # client authentication ON
    'serviceAccountsEnabled': True, # service accounts ON
    'standardFlowEnabled': False,   # browser flow OFF
    'directAccessGrantsEnabled': False,
    'implicitFlowEnabled': False,
})
json.dump(c, open('/dev/stdout', 'w'))
PY
api -X PUT "$KC/admin/realms/$REALM/clients/$UUID" -d @/tmp/kc-client-new.json
rm -f /tmp/kc-client.json /tmp/kc-client-new.json
say "client is now confidential with service accounts enabled"

# --- 2. the audience mapper ---------------------------------------------------
HAS_MAPPER="$(api "$KC/admin/realms/$REALM/clients/$UUID/protocol-mappers/models" \
  | python3 -c 'import sys,json;print(any(m["name"]=="trustos-api-audience" for m in json.load(sys.stdin)))')"
if [ "$HAS_MAPPER" = "False" ]; then
  api -X POST "$KC/admin/realms/$REALM/clients/$UUID/protocol-mappers/models" -d "{
    \"name\": \"trustos-api-audience\",
    \"protocol\": \"openid-connect\",
    \"protocolMapper\": \"oidc-audience-mapper\",
    \"config\": {
      \"included.client.audience\": \"$AUDIENCE\",
      \"access.token.claim\": \"true\",
      \"id.token.claim\": \"false\"
    }
  }"
  say "audience mapper added, emitting $AUDIENCE"
else
  say "audience mapper already present"
fi

# --- 3. the browser client's redirect URIs (TOS-004) --------------------------
WEB_UUID="$(api "$KC/admin/realms/$REALM/clients?clientId=trustos-web" \
  | python3 -c 'import sys,json;c=json.load(sys.stdin);print(c[0]["id"] if c else "")')"
if [ -n "$WEB_UUID" ]; then
  api "$KC/admin/realms/$REALM/clients/$WEB_UUID" > /tmp/kc-web.json
  PORTAL="$PORTAL" python3 - <<'PY' > /tmp/kc-web-new.json
import json, os
c = json.load(open('/tmp/kc-web.json'))
portal = os.environ['PORTAL']
uris = sorted({*c.get('redirectUris', []), f'{portal}/*', f'{portal}/'})
origins = sorted({*c.get('webOrigins', []), portal})
c.update({
    'redirectUris': uris,
    'webOrigins': origins,
    'publicClient': True,           # a browser client holds no secret
    'standardFlowEnabled': True,
    'directAccessGrantsEnabled': False,
    'attributes': {**c.get('attributes', {}), 'pkce.code.challenge.method': 'S256'},
})
json.dump(c, open('/dev/stdout', 'w'))
PY
  api -X PUT "$KC/admin/realms/$REALM/clients/$WEB_UUID" -d @/tmp/kc-web-new.json
  rm -f /tmp/kc-web.json /tmp/kc-web-new.json
  say "trustos-web: redirect URIs and PKCE configured for the DEV portal"
fi

# --- 4. the secret, straight into Railway ------------------------------------
api "$KC/admin/realms/$REALM/clients/$UUID/client-secret" \
  | python3 -c 'import sys,json;sys.stdout.write(json.load(sys.stdin)["value"])' \
  | railway variable set --stdin TRUSTOS_VALIDATION_CLIENT_SECRET \
      -s governance-tool -e dev --skip-deploys
say "client secret written to the DEV service (never printed)"

# --- 5. prove it ---------------------------------------------------------------
say ""
say "verifying with a deliberately wrong secret — expect invalid_client, not unauthorized_client:"
curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d "client_id=$CLIENT_ID" -d client_secret=deliberately-wrong \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("   ->", d.get("error"), "|", d.get("error_description"))'
