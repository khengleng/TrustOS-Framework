#!/usr/bin/env bash
#
# Is the DEV validation client confidential yet?
#
#   bash scripts/operator/check-dev-validation-client.sh
#
# Sends one token request with a deliberately wrong secret and reads the error code.
# No credential is needed, nothing is printed that is sensitive, and nothing is changed.
#
# The error code is the whole diagnosis:
#
#   unauthorized_client  the client exists but is not permitted this grant —
#                        Client authentication is off and/or Service accounts is off
#   invalid_client       the client is confidential and the grant is enabled;
#                        only the secret was wrong, which is expected here
set -euo pipefail

REALM="trustos-dev"
CLIENT="trustos-foundation-validator"

RESULT="$(curl -s -X POST \
  "https://id.cambobia.com/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d "client_id=$CLIENT" \
  -d client_secret=deliberately-wrong-probe-value \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error","<no error field>"))')"

echo "  realm  : $REALM"
echo "  client : $CLIENT"
echo "  result : $RESULT"
echo

case "$RESULT" in
  invalid_client)
    echo "  CONFIGURED. The client is confidential and client-credentials is enabled."
    echo "  Next: copy the secret from the client's Credentials tab into the DEV service:"
    echo
    echo "    read -rs SECRET \\"
    echo "      && printf '%s' \"\$SECRET\" \\"
    echo "      | railway variable set --stdin TRUSTOS_VALIDATION_CLIENT_SECRET \\"
    echo "          -s governance-tool -e dev --skip-deploys \\"
    echo "      && unset SECRET"
    ;;
  unauthorized_client)
    echo "  NOT YET EFFECTIVE. Keycloak still refuses this client the grant."
    echo
    echo "  The quickest way to tell from the Admin Console: a confidential client has a"
    echo "  Credentials tab. A public one does not. Open"
    echo
    echo "    trustos-dev -> Clients -> $CLIENT"
    echo
    echo "  If there is no Credentials tab next to Settings, Client authentication is"
    echo "  still off — the toggle was probably not saved. Scroll to Capability config,"
    echo "  set Client authentication ON and Service accounts roles ON, then press Save"
    echo "  at the bottom of that section and re-run this script."
    ;;
  *)
    echo "  Unexpected result. Nothing was changed."
    ;;
esac
