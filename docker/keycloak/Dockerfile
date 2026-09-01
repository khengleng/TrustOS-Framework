# Keycloak, as the identity provider for the deployed platform.
#
# The upstream image sets an ENTRYPOINT of `kc.sh` and no default command, so a bare
# `docker run` prints help and exits. Railway can only set a start command for an
# image-backed service through its dashboard, which would put a load-bearing piece of
# configuration somewhere it cannot be reviewed or rolled back. Building the image
# here instead keeps the command in the repository with everything else.
#
# Pinned to a patch version deliberately. An identity provider that silently moves
# major version underneath a running deployment is not a convenience.
FROM quay.io/keycloak/keycloak:26.0.7

# Baked into the image rather than passed as configuration: these are the shape of
# the deployment, not per-environment settings.
#
#   - the database is Postgres, always
#   - Railway terminates TLS and forwards X-Forwarded-*, so Keycloak has to trust
#     those headers to build correct issuer and redirect URLs. Without this it
#     advertises http:// URLs behind an https:// domain and every redirect breaks.
#   - health endpoints on, so the platform can probe it like anything else
ENV KC_DB=postgres \
    KC_PROXY_HEADERS=xforwarded \
    KC_HTTP_ENABLED=true \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true

# The realm this platform expects: clients, roles and mappers. Imported on first start
# and ignored afterwards, so editing it here does not silently rewrite a realm an
# operator has since changed by hand.
#
# Repo-relative because Railway builds with the repository root as the context, not
# the directory holding this file.
COPY docker/keycloak/realm-trustos.json /opt/keycloak/data/import/realm-trustos.json

EXPOSE 8080

# `start` rather than `start-dev`: production mode, which refuses to run with an
# in-memory database and requires the hostname and proxy settings to be coherent.
#
# `--import-realm` is idempotent. Keycloak imports a realm only when one of that name
# does not already exist; on every later boot it logs that it is skipping the import.
# `--optimized` is deliberately absent — it requires a build step to have been run
# with the same options, and skipping it costs a few seconds of start-up in exchange
# for the image not silently disagreeing with its own configuration.
CMD ["start", "--import-realm"]
