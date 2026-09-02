# Running Phase 1 locally on Windows

This is the plan for actually standing up the whole Phase 1 stack on a
local Windows machine — every `services/*` composition root built this
session has a `README.md#local-setup` section describing its own piece,
but nothing yet ties them into one end-to-end run. This document is that:
what exists already, what still needs to be built, and the exact sequence
to run it.

Every PR this session shipped with the caveat "not yet verified against
live Postgres/Kafka/Redis — no Docker in the session this was built in."
Nothing in that code has changed since; this plan is how that caveat
finally gets closed out, service by service.

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

**Does not exist yet — this is the actual gap:**
- **No Dockerfile anywhere in the repo.** `infra/README.md` has said
  since Phase 0: "`services/*` app containers are added to
  [`docker-compose.yml`] once each has a Dockerfile and a real
  entrypoint — Phase 1, not before." Every entrypoint now exists; no
  Dockerfile does.
- **No app-service entries in `docker-compose.yml`** — only the four
  infra containers.
- **No `.env` file** — only `.env.example`. Never copied, because
  nothing has been run yet.
- **No orchestration for running 10 long-lived Node processes at once**
  on a single machine outside a container — every README's "Local
  setup" shows one service in isolation (`pnpm --filter X start`),
  correct for that document but not a fleet.

## 1. Prerequisites

- **Docker Desktop for Windows**, WSL2 backend (the standard, current
  recommendation from Docker — the alternate "Windows containers"
  backend cannot run the Linux images this compose file uses). Not
  installed as of this plan being written — `docker --version` fails in
  both this session's Git Bash and PowerShell. Install and confirm
  `docker compose version` succeeds before anything below.
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

## 3. Phase B — full containerization

The roadmap's actual "`docker compose up` demo works end-to-end" item:
one command starts everything, app services included. Bigger lift, not
needed to validate the application code (Phase A already does that) —
this is about the deployment story. Do this after Phase A is green, so
any failure here is known to be a containerization problem, not an
application one.

### 3.1 Dockerfile strategy

One shared, parameterized `Dockerfile` at the repo root (not ten
near-identical ones) — a multi-stage build using `pnpm deploy` to
produce a minimal, production-only bundle for one service at a time:

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
`pnpm@11.4.0` still labels it "Experimental!" in its own `--help`, worth
re-checking against whatever pnpm version is actually installed when
this is built) resolves just that package's real dependency subgraph —
including its `workspace:*` internal deps — into a self-contained,
production-only `node_modules` + `dist`, so the runtime image doesn't
carry the other nine services or any devDependency. Confirmed syntax
(`pnpm --help deploy`, this session): `pnpm --filter=<project name>
deploy <target directory>`, `--prod` for the "skip devDependencies"
behavior used above. Each service's own image is built with `docker
build --build-arg SERVICE=worker-sms .` (etc.) — one Dockerfile, ten
images, via `docker-compose.yml`'s per-service `build.args`.

`infra-postgres`'s Prisma client needs its query-engine binary for the
image's actual platform — `prisma generate` already runs on `postinstall`
(see that package's `package.json`), so it's covered by the `pnpm
install` step above without a separate command, provided the build
stage's platform matches the runtime stage's (both `node:22-alpine`
here, so yes).

### 3.2 `docker-compose.yml` additions

Ten new service blocks, each: `build: { context: .., dockerfile:
Dockerfile, args: { SERVICE: <name> } }`, `depends_on` with
`condition: service_healthy` on whichever of `postgres`/`redis`/`kafka`
it actually needs (see each service's own README's "Depends on"), and
an `environment:` block using the **in-network** hostnames — `postgres`,
`redis`, `kafka:9092` (the `PLAINTEXT://kafka:9092` listener already
configured, not the `PLAINTEXT_HOST` one `.env.example` uses for host
processes) and `http://jaeger:4318` for tracing — not `localhost`,
since these now run inside the compose network, not on the host.
`services/api`/`services/inapp-gateway` also need `ports:` publishing
(`3000:3000`, `3001:3001`) to stay reachable from the host.

### 3.3 What this needs that Phase A doesn't

- The `Dockerfile` above (new).
- Ten new service blocks in `infra/docker-compose.yml` (new).
- A container-appropriate env var set per service — distinct from
  `.env.example`'s host-oriented defaults, per §3.2. Likely as inline
  `environment:` blocks in the compose file itself (simplest, and keeps
  `.env.example` accurate for Phase A) rather than a second `.env`
  variant.
- `infra/README.md` and this document updated once built, the same way
  every other piece of this codebase documents what actually exists
  vs. what's still ahead.

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

## 5. Sequencing

1. Install Docker Desktop (WSL2 backend); confirm `docker compose
   version`.
2. Phase A, in full, including every smoke test — this is what actually
   retires the "not yet verified against live infra" caveat on every
   merged PR this session.
3. Only then, Phase B — write the `Dockerfile`, the compose additions,
   rebuild everything as containers, re-run the same smoke tests against
   the containerized stack.
4. Once both are green: the two multi-hop scenarios called out in §2.5
   (a broadcast; a quiet-hours deferral that re-emits), by hand, as the
   concrete satisfaction of `docs/roadmap.md`'s "`docker compose up`
   demo works end-to-end" item.

Not covered by this plan (genuinely separate, later work — see
`docs/roadmap.md`'s "Future work" section): a hosted deployment, load
testing, Prometheus/Grafana, the DLQ-replay admin endpoint. This
document is scoped to "runs correctly on one local Windows machine,"
nothing past it.
