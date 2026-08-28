#!/usr/bin/env bash
#
# Creates and configures the DEV, UAT and PROD environments on Railway.
#
# Run it yourself. It provisions paid infrastructure — one Postgres and one service instance per
# environment — and it changes a live deployment, so it is deliberately not something automation
# runs on your behalf.
#
#   ./scripts/railway-environments.sh          # show what it would do, change nothing
#   ./scripts/railway-environments.sh --apply  # do it
#
# What it does, and why in this order:
#
#   1. Creates `dev` and `uat` by duplicating the existing `production` environment, so each one
#      starts with the same services rather than being assembled by hand.
#
#   2. **Rotates the signing secrets in every environment.** This is the step that matters most and
#      the one a manual setup skips. `--duplicate` copies variables, so without it all three
#      environments share a JWT_SECRET — and a UAT token would verify in production. See
#      docs/deployment/environments.md: no credential may cross an environment.
#
#   3. Sets TRUSTOS_ENVIRONMENT per environment. NODE_ENV is `production` everywhere, because that
#      is what the word means to Node; TRUSTOS_ENVIRONMENT is what tells UAT from production, and
#      what @trustos/governance-environment-config refuses a lower-environment credential against.
#
#   4. Sets the security posture per environment. DEV and UAT accept the local identity provider
#      explicitly; **production does not** — it is left needing OIDC, which is the honest default.
#
# It does not deploy. Deploying is a separate decision, and doing it from here would mean this
# script both provisions and ships.

set -euo pipefail

SERVICE="trustos-api"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Echoes the command with any secret value redacted.
#
# The first version printed the generated JWT secrets into the dry run, which put them in terminal
# scrollback and anywhere that output was piped — a rehearsal that leaks the thing it is rehearsing
# is worse than no rehearsal.
redacted() {
  local out=""
  for arg in "$@"; do
    case "$arg" in
      *SECRET=*|*PASSWORD=*|*TOKEN=*|*CLIENT_SECRET=*) out+=" ${arg%%=*}=<generated>" ;;
      *) out+=" $arg" ;;
    esac
  done
  printf '%s' "${out# }"
}

run() {
  if [[ $APPLY -eq 1 ]]; then
    say "  \$ $(redacted "$@")"
    "$@"
  else
    say "  would run: $(redacted "$@")"
  fi
}

secret() { openssl rand -base64 48 | tr -d '\n'; }

command -v railway >/dev/null || { say "railway CLI not found"; exit 1; }
railway whoami >/dev/null 2>&1 || { say "Not logged in. Run: railway login"; exit 1; }

if [[ $APPLY -eq 0 ]]; then
  say "DRY RUN — nothing will change. Re-run with --apply to execute."
fi

say ""
say "Logged in as: $(railway whoami 2>&1 | head -1)"
say "Project:      $(railway status 2>/dev/null | grep -i '^Project:' || echo '(not linked)')"

# --- 1. the environments ------------------------------------------------------

step "1. Create dev and uat"

existing="$(railway status --json 2>/dev/null \
  | python3 -c "import json,sys;print(' '.join(e['node']['name'] for e in json.load(sys.stdin).get('environments',{}).get('edges',[])))" \
  2>/dev/null || echo "")"

say "  existing environments: ${existing:-unknown}"

for env in dev uat; do
  if [[ " $existing " == *" $env "* ]]; then
    say "  $env already exists — skipping"
  else
    run railway environment new "$env" --duplicate production
  fi
done

# --- 2. secrets, per environment ----------------------------------------------

step "2. Rotate the signing secrets so no credential crosses an environment"
say "  Without this, --duplicate leaves all three sharing a JWT_SECRET and a UAT"
say "  token verifies in production."

for env in dev uat production; do
  say ""
  say "  $env:"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "JWT_SECRET=$(secret)"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "JWT_REFRESH_SECRET=$(secret)"
done

# --- 3 and 4. posture, per environment ----------------------------------------

step "3. Per-environment configuration"

configure() {
  local env="$1" trustos_env="$2" allow_local="$3" cors="$4"

  say ""
  say "  $env  (TRUSTOS_ENVIRONMENT=$trustos_env, local identity: $allow_local)"

  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "TRUSTOS_ENVIRONMENT=$trustos_env"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "NODE_ENV=production"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "OPENAPI_ENABLED=false"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "TRUST_PROXY=true"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "SECURITY_TOKEN_ISSUER=trustos"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "SECURITY_TOKEN_AUDIENCE=trustos-api"
  run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
      --set "CORS_ORIGINS=$cors"

  if [[ "$allow_local" == "yes" ]]; then
    run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
        --set "IDENTITY_PROVIDER=local"
    run railway variables --service "$SERVICE" --environment "$env" --skip-deploys \
        --set "SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true"
  fi
}

configure dev        dev  yes "https://console-dev.example.com"
configure uat        uat  yes "https://console-uat.example.com"

# Production is deliberately left needing OIDC.
#
# Setting SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true here would disable the control that
# exists to stop a development identity provider running in production. The service will refuse to
# start until OIDC is configured, and that refusal is the policy working.
configure production prod no  "https://console.example.com"

step "4. Production still needs an identity provider"
say "  Deliberately not set. Configure OIDC before deploying production:"
say ""
say "    railway variables --service $SERVICE --environment production \\"
say "      --set 'IDENTITY_PROVIDER=oidc' \\"
say "      --set 'OIDC_ISSUER_URL=https://<issuer>/realms/trustos' \\"
say "      --set 'OIDC_CLIENT_ID=trustos-api' \\"
say "      --set 'OIDC_CLIENT_SECRET=<secret>'"
say ""
say "  Until then production will refuse to start, which is correct."

step "Next"
say "  Replace the CORS_ORIGINS placeholders above with your real console origins."
say "  Then deploy one environment at a time and smoke-test each:"
say ""
say "    railway up --service $SERVICE --environment dev"
say "    TRUSTOS_BASE_URL=https://<dev domain> npm run smoke"
say ""
[[ $APPLY -eq 0 ]] && say "  This was a dry run. Re-run with --apply."
