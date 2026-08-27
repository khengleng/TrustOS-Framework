# syntax=docker/dockerfile:1
#
# One Dockerfile, one argument, every TrustOS service.
#
# The alternative — a Dockerfile per application — is seven files that drift. They would drift in
# the way that matters: one of them would keep a development dependency, or run as root, or miss a
# signal handler, and the difference would be invisible until that service was the one that failed.
#
# `SERVICE` selects which application is built and started. Everything else is identical, which is
# the point: whatever is true of the image running the gateway is true of the image running the
# API.
#
# Build:
#   docker build --build-arg SERVICE=api-example -t trustos/api-example .
#
# The build stage compiles the whole workspace rather than one application. TypeScript project
# references mean an application's build already needs its packages built, and building the
# workspace once is both simpler and faster than resolving which subset a given service needs.

# --- dependencies -------------------------------------------------------------
#
# Separated so a source change does not reinstall node_modules. `npm ci` installs strictly from
# the lockfile: a build that resolved different versions than the ones reviewed would make every
# audit result meaningless.
FROM node:20.19.1-bookworm-slim AS deps

WORKDIR /app

# The lockfile and every workspace manifest, and nothing else. Copying source here would defeat
# the layer.
COPY package.json package-lock.json ./
COPY packages/database/package.json packages/database/
COPY packages/database/prisma packages/database/prisma

# `postinstall` runs `prisma generate`, which needs the schema — copied above.
# `id` is required by some builders — Railway's rejects a cache mount without one, which is how
# this was found. BuildKit defaults the id to the target when it is omitted, so naming it
# explicitly costs nothing and works everywhere.
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci --ignore-scripts && npm run db:generate

# --- build --------------------------------------------------------------------
FROM node:20.19.1-bookworm-slim AS build

ARG SERVICE
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma client, then the workspace, then the one application.
RUN npm run db:generate \
    && npm run build:packages \
    && npm run build -w "@trustos/${SERVICE}"

# Development dependencies removed *after* the build rather than installed separately, so the
# build and the runtime resolve identical versions from one lockfile.
RUN --mount=type=cache,id=npm,target=/root/.npm npm prune --omit=dev

# --- runtime ------------------------------------------------------------------
FROM node:20.19.1-bookworm-slim AS runtime

ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    PORT=3000

WORKDIR /app

# `dumb-init` is PID 1 so SIGTERM reaches Node.
#
# Without it, Node is PID 1 and PID 1 ignores signals it has no handler for — so a container stop
# waits for the platform's timeout and then kills the process mid-request. Nest's shutdown hooks
# never run, in-flight requests are dropped, and the database connection is not closed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# The image runs as the `node` user, which the base image already creates. Root in a container is
# root on the host under a namespace that is not always as isolating as it looks.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 3000

# `/health` answers without touching a dependency, so a database blip does not restart a healthy
# container. Readiness is a separate endpoint and a separate question — see docs/deployment/railway.md.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

# `sh -c` so ${SERVICE} expands at run time. The alternative is a Dockerfile per service.
CMD ["sh", "-c", "node apps/${SERVICE}/dist/main.js"]
