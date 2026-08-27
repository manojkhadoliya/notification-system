# ADR 0001: Monorepo with pnpm workspaces, services/ + packages/

## Status
Accepted

## Context
The system is split into several independently deployable backend
processes (an HTTP API, per-channel queue workers, a projection consumer)
and many small packages (domain contexts, infra adapters, provider
adapters) per the DDD/hexagonal design (see
[`domain-model.md`](../architecture/domain-model.md)). These need to be
developed and versioned together, with fast local cross-package linking
during development, and — critically for the DDD boundary rule in
[ADR 0005](0005-ddd-hexagonal-architecture.md) — a package must not be able
to import another package it hasn't explicitly declared a dependency on.

## Decision
Single git repo, **pnpm workspaces**, with `services/` for composition
roots and `packages/` for domain/infra/provider packages. TypeScript
project references keep builds incremental.

`services/` (not `apps/`) is the top-level folder name for deployable
processes. "App" defaults, for most readers, to meaning a frontend
(mobile/web) application — this project has none. Every entry under
`services/` is a **backend service**: a long-lived process that's either an
HTTP server (`services/api`) or a queue-consumer worker
(`services/worker-sms`, `services/projection-notification`, ...).
`services/` states that directly, without requiring a reader to already
know a framework-specific convention.

## Directory tree

```
notification-system/
  services/                    composition roots — DI wiring + entrypoint only,
                                no business logic
    api/                       Fastify HTTP API — Door 1 (ADR 0007, ADR 0009)
    router/                     single decision point: preferences, quiet
                                 hours, channel, template render (ADR 0009)
    scheduler/                  polls scheduled_notifications, re-emits due
                                 rows (ADR 0011)
    fanout-expander/            broadcast audience descriptor -> chunks ->
                                 per-recipient events (ADR 0011)
    worker-sms/                 consumes command.sms + retry tiers
    worker-push/                 consumes command.push + retry tiers
    worker-email/                  consumes command.email + retry tiers
    worker-inapp/                  consumes command.in_app + retry tiers,
                                    writes the feed row (ADR 0012)
    inapp-gateway/                  stateless WebSocket registry, no Kafka
                                     consumer group (ADR 0012)
    projection-notification/       single writer of NotificationRequest.status,
                                    consumes events.* + delivery-status (ADR 0008, 0010)
  packages/
    domain-notification/       core domain: NotificationRequest/DeliveryAttempt/
                                DedupeClaim/ScheduledNotification, dispatch
                                orchestration, ports (ADR 0005)
    domain-preferences/         Recipient/Preference/RecipientKey domain +
                                 PreferenceRepository/RecipientKeyRepository ports
    domain-identity/             Tenant/ApiKey domain + RateLimitPolicy
    domain-templates/             Template/TemplateVersion domain + TemplateRepository port
    shared-kernel/                 minimal cross-context value objects only
    infra-postgres/             Prisma schema + repository port adapters for
                                 domain-identity/domain-preferences/domain-templates,
                                 and — Phase 1 — domain-notification's read
                                 model too (ADR 0003, revised)
    infra-cassandra/              reserved NotificationRepository/DedupeRepository
                                    adapter for domain-notification, built at a
                                    measured threshold (ADR 0003, ADR 0008)
    infra-kafka/                   MessageBroker port adapter (ADR 0002, ADR 0009)
    infra-redis/                   RateLimiter / IdempotencyStore / pub-sub port adapters
    providers-sms/                 Twilio + mock SmsGateway adapters
    providers-push/                 FCM + mock PushGateway adapters
    providers-email/                 SES/SendGrid + mock EmailGateway adapters
  infra/
    docker-compose.yml           postgres, redis, kafka, services/* containers
                                  (no cassandra until a threshold is crossed)
  docs/
    architecture/                 system design docs
    adr/                          decision records (this file included)
    roadmap.md                    build checklist
```

Every `services/*` and `packages/*` folder carries its own `README.md`
stating its responsibility, the ports it depends on or implements, and
which roadmap phase brings it to life — this tree is the map; the
per-folder READMEs are the detail.

## Alternatives considered

- **npm workspaces**: zero extra tooling (built into npm ≥7), which has
  real value for a portfolio repo a reviewer will clone and expect to just
  work. Rejected because its hoisted, flat `node_modules` allows **phantom
  dependencies** — a `domain-*` package could accidentally resolve
  `infra-postgres` at runtime just because it happens to be hoisted to the
  root, even without declaring it as a dependency. That directly undercuts
  the "domain packages cannot import infra packages" guarantee this ADR and
  ADR 0005 both rely on.
- **Turborepo / Nx**: add dependency-graph-aware task orchestration and
  build/test/lint caching. Not worth the added tooling surface at this
  project's scale (~12-18 packages) — this repo is public, so GitHub
  Actions CI minutes are already free/unlimited, and a full workspace build
  is fast enough that skip-unchanged caching isn't solving a real pain
  point yet. Nx's tag-based `enforce-module-boundaries` is a genuinely nice
  alternative to a hand-rolled dependency-cruiser rule, but adopting Nx's
  daemon/generator/plugin surface just for that one feature isn't
  justified for a project meant to showcase architecture fundamentals, not
  build tooling. Revisit if package count or CI time grows enough to make
  caching matter.
- **`apps/` instead of `services/`**: the more common convention (Express/
  Nx/Nest starter templates default to it), but ambiguous — see "Decision"
  above.

## Rationale for pnpm specifically
- **Strict, non-hoisted `node_modules`** makes an undeclared cross-package
  import fail at `require`/`import` time, not just at lint time — a
  second, runtime-level enforcement of the DDD import boundary, on top of
  a static dependency-cruiser check. Belt-and-suspenders on the one
  architectural guarantee ([ADR 0005](0005-ddd-hexagonal-architecture.md))
  the whole package structure is built to demonstrate.
- Faster installs and far less disk usage than npm, from its
  content-addressable store — a minor but free win.
- Workspace protocol (`workspace:*` dependencies, `pnpm-workspace.yaml`) is
  close enough to npm's that this isn't a large departure from the
  ecosystem norm.

## Consequences
- `pnpm install` at the root sets up the whole system (contributors need
  pnpm installed).
- Package boundaries are enforced twice: at install/runtime by pnpm's
  strict linking, and statically by a dependency-cruiser rule — a
  `domain-*` package cannot import `infra-postgres` in either sense unless
  it's added as a declared dependency.
- Trade-off: all packages share one CI pipeline and one repo history rather
  than being independently publishable/versioned — acceptable since this
  isn't published as separate libraries.
- Occasional friction from stricter resolution (a package silently relying
  on a hoisted transitive dependency breaks under pnpm where it wouldn't
  under npm) — treated as a feature here, not a bug, since surfacing that
  exact class of issue is the point.
