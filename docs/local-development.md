# Running Phase 1 locally on Windows

This is the plan for actually standing up the whole Phase 1 stack on a
local Windows machine — every `services/*` composition root built this
session has a `README.md#local-setup` section describing its own piece,
but nothing yet ties them into one end-to-end run. This document is that:
what exists already, what still needs to be built, and the exact sequence
to run it.

Every PR this session shipped with the caveat "not yet verified against
live Postgres/Kafka/Redis — no Docker in the session this was built in."
**Phase A has now actually been run** (2026-09-02, once Docker Desktop
was installed) — that caveat is retired for every service. See §2.6 for
what that run found (two real bugs, both fixed). **Phase B has now also
actually been run** (2026-09-07) — see §3.4 for what that found (three
more real bugs, all fixed) and §3.5 for the by-hand multi-hop scenarios,
still ahead.

## 0. What already exists vs. what doesn't

**Already built, nothing further needed:**
- `infra/docker-compose.yml` — `postgres`, `redis`, `kafka` (KRaft,
  single broker), `jaeger`. `pnpm compose:up` / `pnpm compose:down`.
- `infra/kafka/create-topics.sh` — every topic in the topology
  ([`messaging.md#topic-layout`](architecture/messaging.md#topic-layout)).
  `pnpm kafka:topics`, idempotent.
- Every `services/*` composition root: a real `src/index.ts` entrypoint,
  a `README.md#local-setup`, and a `scripts/smoke-test.mjs` that
  round-trips one real message through that service against live infra.
- `.env.example` — the full set of env vars every service reads, with
  defaults documented per service.
- `packages/infra-postgres/prisma/migrations/` — as of §2.6's run. This
  did **not** exist before (schema.prisma only, no committed migration),
  meaning `prisma migrate deploy` would have failed on any fresh
  environment with nothing to apply — see §2.6 for how this was found
  and closed.
- `Dockerfile`, `.dockerignore`, `.gitattributes` (repo root), and eleven
  new service blocks (ten app services + `migrate`) in
  `infra/docker-compose.yml` — as of §3.4's run. `infra/README.md` had
  said since Phase 0: "`services/*` app containers are added to
  [`docker-compose.yml`] once each has a Dockerfile and a real
  entrypoint — Phase 1, not before." That's now done; see §3.1-§3.4 for
  what it took.

**Does not exist yet — this is the actual gap:**
- **No `.env` file** — only `.env.example`. Never copied on a fresh
  clone, since nothing has been run on it yet.
- **No orchestration for running 10 long-lived Node processes at once
  on a single machine outside a container**, for Phase A specifically —
  every README's "Local setup" shows one service in isolation (`pnpm
  --filter X start`), correct for that document but not a fleet. Not an
  issue for Phase B — `docker compose up -d` already starts all ten.
- **The two by-hand multi-hop demo scenarios** (§3.5) — not yet run
  against the containerized stack.

## 1. Prerequisites

- **Docker Desktop for Windows**, WSL2 backend (the standard, current
  recommendation from Docker — the alternate "Windows containers"
  backend cannot run the Linux images this compose file uses). Installed
  and confirmed working as of §2.6's run. One install-specific gotcha
  worth knowing: a per-user install can land under
  `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` rather than the
  more commonly-documented `C:\Program Files\Docker\Docker\resources\bin`
  — if `docker --version` fails right after installing even though
  Docker Desktop is visibly running, check the actual install path
  (`Get-CimInstance Win32_Process -Filter "Name='Docker Desktop.exe'"`)
  before assuming the install failed, and make sure that `resources\bin`
  directory is on `PATH` (a shell/session started before the install
  won't pick up a `PATH` change made during it — open a new one).
- **Git Bash** — already present (this session's shell), needed because
  `infra/kafka/create-topics.sh` is a bash script; PowerShell can't run
  it directly.
- **Node.js ≥ 22.13.0, pnpm ≥ 11.0.0** — per the root `package.json`'s
  `engines` field; already satisfied in this session (`pnpm@11.4.0`
  pinned via `packageManager`).
- Ports free on the host: `5432` (postgres), `6379` (redis), `9092`
  (kafka), `16686`/`4317`/`4318` (jaeger), plus whichever app ports are
  in play (`3000` api, `3001` inapp-gateway — see §2).
- No real provider credentials needed. `worker-sms`/`worker-push`
  default to their mock gateways (`SMS_PROVIDER`/`PUSH_PROVIDER` unset);
  `worker-email` has no real adapter built yet at all — always mock. A
  full local run exercises the whole pipeline without touching Twilio,
  FCM, or SES.

## 2. Phase A — hybrid run (fastest path, zero new code)

Infra in Docker, every `services/*` process running directly on the
host via `pnpm --filter <name> start`. This is exactly what every
service's own `README.md#local-setup` already documents, one service at
a time — Phase A is just running all ten together and actually
exercising the pipeline across them. No Dockerfiles, no compose changes,
nothing new to build. This should happen **before** Phase B: it's the
cheapest way to find out whether the application code itself — not the
containerization — has any live-infra surprises, and it's what every
`scripts/smoke-test.mjs` this session wrote is already built to verify.

### 2.1 Bring up infra

```
pnpm compose:up
pnpm kafka:topics
```

Confirm all four containers report healthy (`docker compose -f
infra/docker-compose.yml ps`) before continuing — `pnpm kafka:topics`
will fail fast against a Kafka that isn't ready yet, which is the
correct behavior, not a bug to work around.

**Git Bash + `docker compose exec` gotcha:** `create-topics.sh` execs
`/opt/kafka/bin/kafka-topics.sh` *inside* the container, but Git Bash's
MSYS layer rewrites any argument that looks like a POSIX path before
handing it to `docker.exe` (a native Win32 program) — `/opt/kafka/...`
becomes `C:/Program Files/Git/opt/kafka/...`, and the exec fails with
`no such file or directory` for a path that's correct, just mangled in
transit. Fix: `export MSYS_NO_PATHCONV=1` before running `pnpm
kafka:topics` (or prefix the one command: `MSYS_NO_PATHCONV=1 pnpm
kafka:topics`). Confirmed necessary in this session's Git Bash; not an
issue in PowerShell, which has no POSIX-path rewriting to begin with.

### 2.2 Configure

```
cp .env.example .env
```

`.env.example`'s defaults already point at `localhost` for every
infra dependency, which is correct for this mode (host processes talking
to compose's published ports) — no edits needed to get started.
`PORT=3000`/`HOST=0.0.0.0` cover `services/api`; `services/inapp-gateway`
defaults to `3001` on its own if unset. Every process reads `.env` only
if something loads it — Node doesn't read `.env` files itself, so either
export these into the shell each process starts from, or add a tiny
loader; see §5's note on this.

### 2.3 Build everything once

```
pnpm -w build
```

### 2.3a Run database migrations

```
cd packages/infra-postgres
DATABASE_URL="postgresql://notification:notification@localhost:5432/notification" npx prisma migrate dev --name init --skip-seed
```

**Missing from earlier drafts of this plan — a real gap, not an
oversight worth glossing over.** No `packages/infra-postgres/prisma/
migrations/` directory existed anywhere in the repo before §2.6's run;
`schema.prisma` had never actually been turned into a migration. Every
service's own `README.md#local-setup` correctly assumes *a* schema is
already applied, but nothing in this repo (this plan included, until
now) said how to get from zero to that state. `migrate dev` is right for
this one-time, single-developer, no-other-migrations-yet situation; once
a second migration exists, use `prisma migrate deploy` instead (no
interactive prompts, doesn't try to generate a new migration from
schema drift — the right command for every run after the first).

### 2.4 Start every service

Ten long-lived processes, each `pnpm --filter <name> start`. Order
doesn't matter for correctness — every consumer waits on Kafka, nothing
crashes if a topic has no messages yet — but starting `services/api`
last is convenient, since it's the one you'll immediately use to push
work through the pipeline.

The services, and which ports (if any) they bind:

| Service | Command | Port |
|---|---|---|
| `worker-sms` | `pnpm --filter @notification-system/worker-sms start` | — |
| `worker-push` | `pnpm --filter @notification-system/worker-push start` | — |
| `worker-email` | `pnpm --filter @notification-system/worker-email start` | — |
| `worker-inapp` | `pnpm --filter @notification-system/worker-inapp start` | — |
| `inapp-gateway` | `pnpm --filter @notification-system/inapp-gateway start` | 3001 |
| `router` | `pnpm --filter @notification-system/router start` | — |
| `scheduler` | `pnpm --filter @notification-system/scheduler start` | — |
| `fanout-expander` | `pnpm --filter @notification-system/fanout-expander start` | — |
| `projection-notification` | `pnpm --filter @notification-system/projection-notification start` | — |
| `api` | `pnpm --filter @notification-system/api start` | 3000 |

**Running ten of these at once on Windows** — a plain terminal-tab-per-
service works but doesn't scale past a few. Two zero-new-dependency
options:
- **PowerShell background jobs**: `Start-Job -ScriptBlock { pnpm
  --filter @notification-system/worker-sms start }` per service, `Get-Job`
  to check status, `Receive-Job -Id <n>` for output, `Stop-Job` /
  `Remove-Job` to tear down.
- **A small orchestration script** (`infra/start-local.ps1` /
  `stop-local.ps1`, not built yet) that starts all ten as background
  jobs, redirecting each to its own log file under a `logs/` directory,
  and a matching stop script. Worth building once Phase A has been run
  manually at least once, so the script encodes a sequence that's
  actually been proven to work rather than a guess.

### 2.5 Verify — run every smoke test

```
pnpm --filter @notification-system/router smoke-test
pnpm --filter @notification-system/worker-sms smoke-test
pnpm --filter @notification-system/worker-push smoke-test
pnpm --filter @notification-system/worker-email smoke-test
pnpm --filter @notification-system/worker-inapp smoke-test
pnpm --filter @notification-system/inapp-gateway smoke-test
pnpm --filter @notification-system/scheduler smoke-test
pnpm --filter @notification-system/fanout-expander smoke-test
pnpm --filter @notification-system/projection-notification smoke-test
pnpm --filter @notification-system/api smoke-test
```

Each one is independent and already written to assert something
specific and real (see that package's own script header comment) — a
dedupe-claim redelivery for the workers, a real WebSocket push for
`inapp-gateway`, a sharded claim for `scheduler`, a real two-stage
fan-out for `fanout-expander`, a real `accepted -> sent -> delivered`
chain for `projection-notification`. Running all ten in sequence against
one live stack is the closest thing to the roadmap's "integration tests"
item this plan gets to without writing new test code — genuinely
worthwhile evidence, even though it's not a substitute for that item.

**A true end-to-end pass** (not just each service in isolation): use
`services/api`'s smoke test's pattern — `POST /v1/notifications` for a
real request — and separately watch `docker compose -f
infra/docker-compose.yml logs -f kafka` or each service's own stdout to
confirm a message actually crosses `events.* → command.* →
delivery-status` and the resulting `NotificationRequest` reaches
`delivered` via `GET /v1/notifications/:id`. Also worth exercising by
hand once smoke tests are green: a broadcast (Door 2 → `fanout-expander`
→ many recipients) and a quiet-hours deferral that the scheduler later
re-emits — the two multi-hop scenarios `docs/roadmap.md`'s
"`docker compose up` demo" item specifically calls out.

### 2.6 Executed — results (2026-09-02)

Phase A has actually been run against live Postgres/Kafka/Redis on this
machine, once Docker Desktop was installed: all four infra containers
healthy, all 25 topics created, all ten services started and joined
their consumer groups cleanly, all ten `scripts/smoke-test.mjs` passed.
The exercise found two real bugs — both fixed, not just noted — plus one
tooling-only issue in the smoke tests themselves. None of this was
hypothetical; every item below reproduced directly in this run.

**1. `infra/docker-compose.yml`'s Kafka port mapping was wrong**
(infra bug, not application code). It published host `9092 → container
9092` — the *internal* `PLAINTEXT` listener, advertised to clients as
`kafka:9092`. The listener actually meant for host access,
`PLAINTEXT_HOST` (advertised as `localhost:9092`), was bound to
container port `29092`, which was never published at all. A host
process could complete Kafka's initial bootstrap handshake (hitting
whichever listener happens to be on the published port) but then failed
every real connection with `getaddrinfo ENOTFOUND kafka` — the broker's
metadata response told it to reconnect to `kafka:9092`, a hostname that
only resolves inside the compose network. **Fixed:** `ports:
["9092:29092"]` — see that file's own comment for the full listener
walkthrough. This had never been caught before because nothing had ever
run a host process against this compose file until now.

**2. A real race between two independent Kafka consumers, surfaced
under live load.** `services/router`'s `dispatch()` publishes a command
(to `command.{channel}`, consumed by a channel worker) and an
`"accepted"` `DeliveryStatusEvent` (to `delivery-status`, consumed by
`services/projection-notification`, which creates the
`NotificationRequest` row). A channel worker's own `DeliveryAttempt`
write has a real Postgres foreign key to that same
`NotificationRequest.id`. Kafka gives no cross-topic ordering guarantee,
and a worker can be faster than projection-notification — confirmed
happening locally, not a theoretical edge case: `worker-sms` hit
`PrismaClientKnownRequestError P2003` (foreign key violation) trying to
record an attempt for a `NotificationRequest` row that
projection-notification hadn't written yet. **Fixed two ways, together
(reordering alone can't close this — Kafka still gives no guarantee
either way):**
- `router-service.ts`'s `dispatch()` now publishes `"accepted"` *before*
  the command, narrowing the window in the common case.
- `PostgresNotificationRepository.saveAttempt` now retries a P2003 up to
  5 times with a short backoff before giving up — the parent row is
  guaranteed to arrive soon, so this converts an inherent race into a
  brief, bounded wait instead of a crash. A P2003 that outlives every
  retry still throws — a genuinely wrong `notificationRequestId` is a
  real bug, not a race, and shouldn't be swallowed.

**3. Tooling-only: every Kafka-touching `scripts/smoke-test.mjs`
(`router`, `scheduler`, `fanout-expander`, `projection-notification`,
all four `worker-*`) and `inapp-gateway`'s own only closed its
consumer/producer/socket/Redis handles on the *success* path.** A failed
assertion or a `withTimeout()` rejection skipped straight to `.catch()`,
leaving those open connections keeping the process alive forever instead
of actually exiting non-zero as every one of these scripts' own header
comments promise. Reproduced directly: a genuinely failing router smoke
test run (see finding 4 below) hung indefinitely instead of printing its
failure and exiting — confirmed via `[exited with code 0]` only *after*
manually killing an unrelated zombie process from an earlier failed run
freed up something that let it proceed. **Fixed** by moving all cleanup
into each script's shared `.finally()`, guarded by existence checks, so
it runs on every path.

**4. Also tooling-only, and only visible after fixing #2:**
`router`'s own smoke test recorded *whatever* `delivery-status` message
arrived for its key, not specifically the `"accepted"` one its own
header comment says it's testing. Before the P2003 fix, `worker-sms`
never got far enough to publish its own `"sent"` `delivery-status` for
the same `notificationRequestId`, so this never had a chance to
misfire. Once workers process fast and reliably (post-fix), `"sent"`
can arrive and overwrite the map entry the test reads back, failing an
assertion (`expected: 'accepted', actual: 'sent'`) that has nothing to
do with `services/router` actually working correctly. **Fixed** by
having the message handler ignore non-`"accepted"` `delivery-status`
messages, matching the test's own stated intent.

All ten `scripts/smoke-test.mjs` pass cleanly against this fixed stack;
`pnpm -w test`/`typecheck`/`lint`/`boundaries` all still pass unit-level
(these are real infra/production/tooling fixes, not workarounds, and the
existing fakes-based unit tests already covered the code paths touched).

## 3. Phase B — full containerization

The roadmap's actual "`docker compose up` demo works end-to-end" item:
one command starts everything, app services included. Bigger lift, not
needed to validate the application code (Phase A already does that) —
this is about the deployment story. Done after Phase A was green, so
any failure here was known to be a containerization problem, not an
application one — see §3.4 for what that separation actually caught in
practice.

### 3.1 Dockerfile strategy

**As actually built (see §3.4 for how this differs from the original
plan below, and why).** One shared `Dockerfile` at the repo root (not
ten near-identical ones), three stages:

- `build` — `node:22-alpine` + `openssl` (§3.4 finding 1), full
  `pnpm install --frozen-lockfile` + `pnpm -w build` of the whole
  workspace.
- `migrate` — reuses `build` as-is, `ENTRYPOINT ["npx", "prisma",
  "migrate", "deploy"]` from `packages/infra-postgres`. What
  `infra/docker-compose.yml`'s `migrate` service (§3.2) runs.
- `runtime` — `node:22-alpine` + `openssl`, `COPY --from=build /repo .`
  (the *entire* built workspace, not a per-service slice — see §3.4
  finding 2 for why), `WORKDIR /repo/services/${SERVICE}`, `CMD ["node",
  "dist/index.js"]`.

Each service's own image is built with `docker build --build-arg
SERVICE=worker-sms .` (etc.) — one Dockerfile, ten images, via
`docker-compose.yml`'s per-service `build.args`.

The original plan (below, kept for the record) called for `pnpm deploy
--prod` in the runtime stage instead, to produce a minimal,
per-service bundle rather than copying the whole workspace into every
image. It doesn't work on this repo — see §3.4 finding 2 for the actual
errors and why the fallback (`--legacy`) doesn't work either. What's
below was the plan going in; §3.4 is what actually happened.

<details>
<summary>Original plan (superseded by §3.4 finding 2)</summary>

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -w build
ARG SERVICE
RUN pnpm --filter "@notification-system/${SERVICE}" deploy --prod /out

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /out .
CMD ["node", "dist/index.js"]
```

`pnpm deploy --prod` (pnpm's built-in monorepo-aware deploy command —
`pnpm@11.4.0` still labels it "Experimental!" in its own `--help`)
was expected to resolve just that package's real dependency subgraph —
including its `workspace:*` internal deps — into a self-contained,
production-only `node_modules` + `dist`. Also assumed: `infra-postgres`'s
Prisma query-engine binary needs no extra step since `prisma generate`
already runs on `postinstall` and both stages share a platform — true as
far as it goes, but missing the OpenSSL dependency entirely (§3.4
finding 1).

</details>

### 3.2 `docker-compose.yml` additions

Ten new service blocks, each: `build: { context: .., dockerfile:
Dockerfile, args: { SERVICE: <name> } }`, `depends_on` with `condition:
service_healthy` on whichever of `postgres`/`redis`/`kafka` it actually
needs (see each service's own README's "Depends on") *plus* `migrate:
{ condition: service_completed_successfully }` for every service that
has a `DATABASE_URL` — see below — and an `environment:` block using
the **in-network** hostnames — `postgres`, `redis`, `kafka:9092` (the
`PLAINTEXT://kafka:9092` listener — a containerized service, unlike a
host process, talks to Kafka over the compose network, so it wants this
listener, not `PLAINTEXT_HOST`) and `http://jaeger:4318` for tracing —
not `localhost`, since these now run inside the compose network, not on
the host. `services/api`/`services/inapp-gateway` also need `ports:`
publishing (`3000:3000`, `3001:3001`) to stay reachable from the host —
see §3.4 finding 3 for a real, machine-specific gotcha with these two.

One more block beyond the ten services, not in the original plan: a
`migrate` one-off (`build.target: migrate`, `restart: "no"`) that runs
`prisma migrate deploy` against `$DATABASE_URL` once, before any
DATABASE_URL-using service starts. Phase A never needed this as a
separate step — it was run by hand, once, directly on the host (§2.3a).
A fresh containerized stack has no such one-time step unless something
runs it; without `migrate`, the first container to touch Postgres would
find no schema at all.

This `PLAINTEXT` vs. `PLAINTEXT_HOST` split is exactly what §2.6 found
broken for the *host-process* side (`kafka`'s container port was
publishing the wrong internal listener) — that fix
(`infra/docker-compose.yml`'s `ports: ["9092:29092"]`) is what makes
`.env.example`'s `KAFKA_BROKERS=localhost:9092` actually reach
`PLAINTEXT_HOST` today. It doesn't affect this section: a containerized
service reaches Kafka over the compose network directly, via the
`PLAINTEXT` listener's own container port (9092), never through the
host-published port at all.

### 3.3 What this needed that Phase A didn't

- The `Dockerfile` (new, repo root).
- `.dockerignore` (new, repo root) — without it, `COPY . .` in the
  `build` stage would pull in the host's own `node_modules` (built for
  Windows — wrong-platform native bindings, Prisma engine included) and
  `.git`, bloating the build context for no benefit. Not called out in
  the original plan at all; a real gap, found before it could bite by
  checking for one before the first build rather than after a strange
  failure.
- `.gitattributes` (new, repo root) — `Dockerfile text eol=lf` and `*.sh
  text eol=lf`, forcing LF regardless of this checkout's
  `core.autocrlf=true` (see §4's existing note on why CRLF breaks both).
- Eleven new service blocks in `infra/docker-compose.yml` (ten app
  services + `migrate`; new).
- A container-appropriate env var set per service, inline in each
  compose block per §3.2 (keeps `.env.example` accurate for Phase A
  rather than adding a second `.env` variant).

### 3.4 Executed — results (2026-09-07)

Phase B has actually been run: all ten images built, all ten containers
plus `migrate` started against the same live Postgres/Kafka/Redis/Jaeger
from §2.6, nine of ten smoke tests passed from the host and the tenth
(`api`) confirmed passing from inside its own container (see finding 3).
Three real bugs found, all fixed — none of this was hypothetical.

**1. Alpine ships no OpenSSL, and Prisma's query engine needs it.**
`prisma generate`'s postinstall (the `build` stage) ran without error
either way, which is what made this easy to miss — but silently
defaulted to the wrong engine (`prisma:warn Prisma failed to detect the
libssl/openssl version to use... Defaulting to "openssl-1.1.x"`), and
the `migrate` stage's `prisma migrate deploy` then failed outright:
`Error: Could not parse schema engine response: SyntaxError: Unexpected
token 'E', "Error load"... is not valid JSON` — the engine binary had
nothing to link against. **Fixed:** `RUN apk add --no-cache openssl` in
both the `build` stage (so `prisma generate` detects the right engine)
and the `runtime` stage (every `services/*` process loads this same
query engine at request time, not just at generate time). The classic,
well-documented Prisma-on-Alpine gap — missed here because §3.1's
original plan never actually ran anything, just read `pnpm --help
deploy`.

**2. `pnpm deploy` does not work on this repo, in either mode.** The
default (non-legacy) deploy refuses to run at all:
`[ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE] ... we only deploy from
workspaces that have "inject-workspace-packages=true" set`. Setting
that — the suggested fix — turned out to be the wrong direction: it has
to be active back at the `pnpm install` step, and doing that
repo-wide (a committed `.npmrc`) would also change how *host*
development links workspace packages, from symlinks to copies — a
`pnpm -w build` would stop showing up to an already-running process
immediately, a real regression for Phase A's whole workflow. Scoping it
to just the Docker build's install step instead hit a second wall:
`pnpm install --frozen-lockfile` then refuses, because the *lockfile
itself* records which mode it was generated in
(`[ERR_PNPM_LOCKFILE_CONFIG_MISMATCH] ... "settings.injectWorkspacePackages"
... doesn't match the value found in the lockfile`) — there's no way to
flip this on for one install without either committing it or dropping
`--frozen-lockfile`. Falling back to `--legacy` (pnpm's suggested
alternative, and the one that doesn't need the injection setting at
all) gets further — it does copy workspace packages by value instead of
symlinking — but then fails on its own: re-running
`packages/infra-postgres`'s `postinstall` (`prisma generate`) inside the
fresh, standalone target directory it builds fails outright (`Error:
Command failed with exit code 1: npm i @prisma/client@5.22.0 --silent`),
a bug in pnpm's legacy deploy implementation itself, not something this
repo's config can route around. **Fixed** by abandoning `pnpm deploy`
entirely: the `runtime` stage now `COPY --from=build /repo .`s the whole
already-built workspace and sets `WORKDIR` to just the one service being
run. Bigger images (all ten services' code and every devDependency, not
just the one running) — a real, documented tradeoff, not a hidden one —
but everything in it was actually built and started, unlike the minimal
version, which never got past `RUN pnpm deploy`.

**3. Machine-specific: Windows/WSL2 can silently steal a published
container port.** `services/api`'s smoke test, run from the host against
`http://localhost:3000`, failed with `404 !== 201` — but the response
body was a *Ruby-on-Rails* `ActionController::RoutingError` page, not
this codebase's Fastify 404 handler. `services/api`'s own container was
completely healthy the whole time (confirmed via `docker compose exec
api netstat`: `0.0.0.0:3000` bound to the container's own `node`
process; confirmed further by running `scripts/smoke-test.mjs` *from
inside* the container itself, which passed cleanly). The actual cause:
`Get-NetTCPConnection -LocalPort 3000` on the host showed `wslrelay.exe`
(WSL2's own port-forwarding relay, distinct from Docker Desktop's own
`com.docker.backend.exe`) also bound to that port — some unrelated
process in a different WSL2 distro on this machine was independently
listening on container-port-equivalent 3000, and Windows' relay layer
routed the smoke test's request to *that*, not to Docker's own forward
into this compose network. Port 3001 (`inapp-gateway`) showed the same
`wslrelay.exe`/`com.docker.backend.exe` pairing in
`Get-NetTCPConnection` but had no real conflict — that pairing alone is
normal Docker-Desktop-on-WSL2 plumbing, not a symptom; `3000`'s actual
second real listener was the anomaly. **Not fixed in the repo** — there
is nothing in this codebase to fix; `infra/docker-compose.yml` keeps
publishing `3000`/`3001`, the canonical ports `.env.example` and every
other doc already assume. **Workaround, machine-specific:** before
trusting a `curl`/smoke-test failure against a published container port
on Windows, check `Get-NetTCPConnection -LocalPort <port> -State
Listen` for more than Docker's own two processes; if something else is
there, either stop it or remap that one service's host port in a local
compose override (`ports: ["3010:3000"]`) rather than assuming the
container itself is broken.

All ten smoke tests pass against the containerized stack (nine
run from the host normally; `api`'s from inside its own container, per
finding 3; `scheduler`'s hit the same pre-existing test-harness race
documented in §2.6 — its own throwaway consumer racing the
already-running live `scheduler` container's poller — confirmed
via that container's own logs actually emitting the seeded row during
the same window, same benign artifact as before, not re-litigated here).
`pnpm -w test`/`typecheck`/`lint`/`boundaries` all still pass unit-level.

### 3.5 Still ahead

Once Phase B is green (it is, as of §3.4): the two multi-hop scenarios
called out in §2.5 (a broadcast; a quiet-hours deferral that re-emits),
by hand, against the containerized stack, as the concrete satisfaction
of `docs/roadmap.md`'s "`docker compose up` demo works end-to-end" item.
Not done yet.

## 4. Windows-specific things already known to bite

- **CRLF line endings.** This repo's `core.autocrlf=true` checkout
  means `infra/kafka/create-topics.sh` and the `Dockerfile` above must
  keep LF line endings to run inside a Linux container/Git Bash — verify
  with `git config core.autocrlf` and, if needed, a `.gitattributes`
  entry (`*.sh text eol=lf`, `Dockerfile text eol=lf`) rather than
  relying on autocrlf to leave them alone.
- **Prettier's CRLF vs. LF noise.** Running `prettier --write .`
  unscoped on this checkout flags ~200+ untouched files purely from
  Windows line endings, not real formatting debt — always scope
  `prettier --write`/`--check` to files actually touched, and verify
  with `git diff --stat` before trusting the result. (Already the
  house rule for this repo; restated here because new infra files are
  exactly the kind of thing that's easy to forget it for.)
- **`prisma format`/`prisma validate` need `DATABASE_URL` set** in the
  shell even though neither makes a live connection — set it inline for
  just that command if editing `schema.prisma` locally
  (`DATABASE_URL="postgresql://notification:notification@localhost:5432/notification"
  pnpm --filter @notification-system/infra-postgres exec prisma
  format`). Plain `prisma generate` (what `postinstall`/the Dockerfile
  build stage actually run) does not need it.
- **`.env` isn't auto-loaded by Node.** Unlike some frameworks, nothing
  in this codebase calls `dotenv.config()` — every `config.ts` reads
  `process.env` directly, by design (see any service's own `config.ts`
  doc comment: "takes an env object rather than reading `process.env`
  internally so it's a pure, unit-testable function"). For Phase A,
  either export `.env`'s contents into the shell each service starts
  from (PowerShell: no built-in `.env` loader either — a one-line loop
  over `Get-Content .env` setting `$env:` vars works) or add a
  lightweight loader to each `start` script if this becomes painful
  enough to justify a new dependency.
- **Alpine's `node` image ships no OpenSSL, and Prisma's query engine
  needs it.** See §3.4 finding 1 for the exact failure — `RUN apk
  add --no-cache openssl` before anything Prisma-related runs, in every
  stage that touches it (`prisma generate` at build time, the actual
  query engine at run time).
- **WSL2 can silently steal a published container port.** See §3.4
  finding 3 — `wslrelay.exe` multiplexes a Windows-side port across
  every WSL2 distro that's listening on it, Docker Desktop's own
  containers included, so a `curl`/smoke-test failure against
  `localhost:<published port>` isn't necessarily this stack's fault.
  Check `Get-NetTCPConnection -LocalPort <port> -State Listen` for more
  than Docker's own two processes before assuming the container is
  broken.

## 5. Sequencing

1. ✅ Install Docker Desktop (WSL2 backend); confirm `docker compose
   version`.
2. ✅ Phase A, in full, including every smoke test — done, see §2.6.
   This retires the "not yet verified against live infra" caveat on
   every merged PR this session.
3. ✅ Phase B, in full, including every smoke test — done, see §3.4.
4. **Not yet done** — the two multi-hop scenarios called out in §2.5 (a
   broadcast; a quiet-hours deferral that re-emits), by hand, against
   the containerized stack, as the concrete satisfaction of
   `docs/roadmap.md`'s "`docker compose up` demo works end-to-end" item.

Not covered by this plan (genuinely separate, later work — see
`docs/roadmap.md`'s "Future work" section): a hosted deployment, load
testing, Prometheus/Grafana, the DLQ-replay admin endpoint. This
document is scoped to "runs correctly on one local Windows machine,"
nothing past it.
