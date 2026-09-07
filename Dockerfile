# syntax=docker/dockerfile:1

# One shared Dockerfile for every services/* composition root — not ten
# near-identical ones. Build one service's image with:
#
#   docker build --build-arg SERVICE=worker-sms -t worker-sms .
#
# (infra/docker-compose.yml's ten app-service blocks do this via
# `build.args`.) The `migrate` stage below is the other thing this
# produces — a one-off `prisma migrate deploy` runner, built with
# `--target migrate` and no SERVICE arg — see that stage's own comment.
#
# The `runtime` stage copies the *entire* built workspace rather than
# using `pnpm deploy` to slim it down to one service's real dependency
# subgraph — see that stage's comment for why: `pnpm deploy` (still
# labelled "Experimental!" in pnpm@11.4.0's own --help) turned out to be
# genuinely broken for this repo, not just inconvenient. Documented in
# full in docs/local-development.md#31-dockerfile-strategy.

FROM node:22-alpine AS build
# Prisma's query engine needs OpenSSL, and Alpine's node image ships
# none — without this, `prisma generate`/postinstall (this stage) can't
# detect a libssl version and silently defaults to the wrong engine, and
# the `migrate` stage's `prisma migrate deploy` fails outright
# ("Could not parse schema engine response") because the engine binary
# has nothing to link against. Found by actually running the `migrate`
# stage against live Postgres — the build itself succeeds either way,
# which is what made this easy to miss. The `runtime` stage below needs
# the same package for the identical reason: every services/* process
# loads this same query engine at request time, not just at generate
# time.
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -w build

# infra/docker-compose.yml's `migrate` service: applies
# packages/infra-postgres/prisma/migrations/ to $DATABASE_URL, then
# exits. Reuses the `build` stage as-is (needs the `prisma` CLI, a
# devDependency, and the schema + migrations directory — nothing this
# stage's own install/build steps stripped out).
FROM build AS migrate
WORKDIR /repo/packages/infra-postgres
ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]

# Per-service runtime image. The plan this followed
# (docs/local-development.md#31, written before any of this was actually
# run) called for `pnpm deploy --prod` here — pnpm's built-in
# monorepo-aware command that resolves just one service's real dependency
# subgraph into a minimal, standalone bundle, leaving the other nine
# services and all devDependencies behind. It does not work on this repo
# as of pnpm@11.4.0: the default (non-legacy) deploy refuses to run at
# all unless every workspace:* dependency was installed with
# `inject-workspace-packages=true` (a setting that would also change how
# *host* development links workspace packages — copies instead of
# symlinks, so a `pnpm -w build` stops showing up to an already-running
# process immediately, a real regression for Phase A); and
# `--legacy` — the suggested fallback that doesn't need that setting —
# re-installs the deployed package's dependency tree from scratch in a
# standalone target directory, where packages/infra-postgres's own
# `prisma generate` postinstall then fails outright (`Error: Command
# failed with exit code 1: npm i @prisma/client@5.22.0 --silent`), a
# problem in pnpm's legacy deploy implementation itself, not something
# this repo's config can route around. Both were actually run against
# this repo, not just read about — see docs/local-development.md#31 for
# the full trail.
#
# So: copy the whole already-built workspace instead. Bigger images (all
# ten services' code and every devDependency in each one, not just the
# one being run) and a real, documented tradeoff — but correct, and
# every bit of it was actually built and started, unlike the minimal
# version above.
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /repo
COPY --from=build /repo .
ARG SERVICE
RUN test -n "$SERVICE" || (echo "Missing required --build-arg SERVICE=<service-dir-name>, e.g. worker-sms" >&2 && exit 1)
WORKDIR /repo/services/${SERVICE}
CMD ["node", "dist/index.js"]
