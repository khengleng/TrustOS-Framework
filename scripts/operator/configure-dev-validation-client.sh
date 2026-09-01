#!/usr/bin/env bash
#
# Configures the DEV validation client in Keycloak, then hands its secret to Railway.
#
#   bash scripts/operator/configure-dev-validation-client.sh
#
# Run by an operator, on their own machine. The Keycloak administrator credential is
# sought in the environment, then on the Railway service, then at an interactive
# prompt; whichever answers, it is never printed, never written to a file, never
# passed as an argument, and never leaves this process. The client secret goes
# straight from Keycloak into a Railway variable through a pipe — not echoed either.
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

# The credential is sought in three places, in order:
#
#   1. KC_ADMIN_USERNAME / KC_ADMIN_PASSWORD in the environment, if both are set
#   2. the Railway keycloak service, which holds the original bootstrap values
#   3. an interactive prompt, if this is a terminal and neither of those was accepted
#
# Step 3 exists because a bootstrap credential only applies on a realm's first start:
# once the administrator password is rotated, the Railway variable is stale and the
# working password exists only wherever it was rotated to. Tracked as TOS-015.

TOKEN=""
RESPONSE=""

# Exchanges an administrator username and password for a master-realm token. Sets
# TOKEN on success, and leaves the raw body in RESPONSE either way. No -f: the error
# body is the diagnosis, and swallowing it turns a clear OAuth message into an opaque
# JSON parse failure further down.
admin_token() {
  RESPONSE="$(curl -s -X POST "$KC/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=$1" --data-urlencode "password=$2")"
  TOKEN="$(printf '%s' "$RESPONSE" | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("access_token",""))
except Exception:
    print("")' 2>/dev/null)"
  [ -n "$TOKEN" ]
}

# Says what Keycloak said about a refused credential, without echoing the credential.
explain_refusal() {
  printf '%s' "$RESPONSE" | python3 -c 'import sys,json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    print("    error:", d.get("error"))
    print("    description:", d.get("error_description"))
except Exception:
    print("    (not JSON) first 200 chars:", raw[:200])'
}

KCU=""
KCP=""

if [ -n "${KC_ADMIN_USERNAME:-}" ] && [ -n "${KC_ADMIN_PASSWORD:-}" ]; then
  KCU="$KC_ADMIN_USERNAME"
  KCP="$KC_ADMIN_PASSWORD"
  SOURCE="the environment"
else
  say "reading the Keycloak administrator credential from Railway (not printed)"
  # 2>/dev/null: the Railway CLI writes deprecation warnings that would otherwise be
  # interleaved with the values.
  VARS="$(railway variables -s keycloak -e production --kv 2>/dev/null)"
  KCU="$(printf '%s\n' "$VARS" | sed -n 's/^KC_BOOTSTRAP_ADMIN_USERNAME=//p')"
  KCP="$(printf '%s\n' "$VARS" | sed -n 's/^KC_BOOTSTRAP_ADMIN_PASSWORD=//p')"
  unset VARS
  SOURCE="the Railway keycloak service"
fi

if [ -n "$KCU" ] && [ -n "$KCP" ]; then
  say "credential read from $SOURCE: username ${#KCU} chars, password ${#KCP} chars (values withheld)"
  if admin_token "$KCU" "$KCP"; then
    say "admin token obtained"
  else
    say ""
    say "$SOURCE was refused. Keycloak said:"
    explain_refusal
  fi
else
  say "no administrator credential found in $SOURCE"
fi
unset KCP

# Interactive fallback. Three attempts, then stop rather than walk the account into
# whatever lockout policy the realm has.
if [ -z "$TOKEN" ] && [ -t 0 ]; then
  say ""
  say "Enter an administrator credential for the master realm. It is read straight into"
  say "this process: not echoed, not stored, not passed as an argument."
  ATTEMPT=1
  while [ -z "$TOKEN" ] && [ "$ATTEMPT" -le 3 ]; do
    printf '  username [%s]: ' "${KCU:-admin}" >&2
    read -r TRY_USER || true
    TRY_USER="${TRY_USER:-${KCU:-admin}}"
    printf '  password: ' >&2
    read -rs TRY_PASS || true
    printf '\n' >&2
    if admin_token "$TRY_USER" "${TRY_PASS:-}"; then
      say "admin token obtained for $TRY_USER"
    else
      say "refused:"
      explain_refusal
      ATTEMPT=$((ATTEMPT + 1))
    fi
    unset TRY_PASS
  done
  unset TRY_USER
fi
unset KCU

if [ -z "$TOKEN" ]; then
  echo
  echo "  ADMIN AUTHENTICATION FAILED. Nothing was changed."
  echo
  echo "  Most likely: KC_BOOTSTRAP_ADMIN_PASSWORD on the Railway service is the"
  echo "  original bootstrap value, and the administrator password has since been"
  echo "  changed. A bootstrap credential only applies on a realm's first start; it"
  echo "  is not updated when someone rotates the password afterwards."
  echo
  echo "  Supply the working credential either way:"
  echo
  echo "    - run this script in a terminal and type it at the prompt, or"
  echo "    - export KC_ADMIN_USERNAME and KC_ADMIN_PASSWORD, then re-run"
  echo
  echo "  Tracked as TOS-015 in docs/findings/REGISTER.md."
  exit 1
fi

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
