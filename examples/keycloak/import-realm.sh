#!/usr/bin/env bash
#
# Re-imports the development realm into a running Keycloak.
#
# `docker compose up` already imports it on first start, when the database is empty.
# This script is for the second time onwards: after editing realm-trustos-dev.json,
# run this to apply the change without destroying the database.
#
# It uses the admin CLI inside the container, so no admin credential is written to
# your shell history and none is passed on a command line where `ps` would show it.

set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "No .env found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

: "${KEYCLOAK_ADMIN:?set KEYCLOAK_ADMIN in .env}"
: "${KEYCLOAK_ADMIN_PASSWORD:?set KEYCLOAK_ADMIN_PASSWORD in .env}"

container="$(docker compose ps -q keycloak)"
if [[ -z "$container" ]]; then
  echo "Keycloak is not running. Start it with: docker compose up -d" >&2
  exit 1
fi

echo "Authenticating to the admin API..."
# The password goes in on stdin rather than as an argument, so it does not appear in
# the container's process list.
docker exec -i "$container" /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "$KEYCLOAK_ADMIN" \
  --password-stdin <<<"$KEYCLOAK_ADMIN_PASSWORD"

echo "Importing realm trustos-dev..."
docker exec -i "$container" /opt/keycloak/bin/kcadm.sh create partialImport \
  -r trustos-dev \
  -s ifResourceExists=OVERWRITE \
  -f /opt/keycloak/data/import/realm-trustos-dev.json \
  || {
    echo
    echo "Partial import failed. If this is the first import, the realm may not exist yet:" >&2
    echo "  docker compose down -v && docker compose up -d" >&2
    echo "recreates the database and imports the realm from scratch." >&2
    exit 1
  }

echo "Done. Issuer: http://localhost:${KEYCLOAK_PORT:-8080}/realms/trustos-dev"
