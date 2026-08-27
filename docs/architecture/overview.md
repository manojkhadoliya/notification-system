# Architecture Overview

This is the detailed component view. For requirements, capacity estimation,
and a summary of key decisions in one read, start with
[`high-level-design.md`](high-level-design.md) instead.

## Goals

- Demonstrate a realistic multi-channel notification pipeline (SMS, Push,
  Email, and In-app, built together per
  [ADR 0004](../adr/0004-channel-rollout.md)) with reliable async
  delivery.
- Show Domain-Driven Design in practice: bounded contexts, ports and
  adapters, no domain-to-infrastructure coupling.
- Run entirely on local/free-tier infrastructure while remaining structured
  so a later migration to paid, scaled infra touches only adapter packages.

## Component diagram (SMS + Push shown; Email follows the identical pattern)

Notification Delivery's hot path is event-driven (Kafka, Postgres for
Phase 1 — see [ADR 0003](../adr/0003-polyglot-persistence.md), revised);
Identity & Tenancy / Recipient Preferences / Templates also stay on
Postgres, looked up by the router. `worker-email` is structurally identical
to `worker-sms`/`worker-push` (own topic, own gateway port) and omitted
below only for diagram size; `worker-inapp` + `inapp-gateway` are genuinely
different — see
[`messaging.md`](messaging.md#in-app-is-structurally-different) — and also
omitted here. Full topology, including the two ingress doors and fan-out,
is in [`messaging.md`](messaging.md).

```
Client / API consumer          Internal service
      │  (API key auth,              │  (producer library,
      │   Idempotency-Key)           │   no HTTP hop)
      ▼                              ▼
 ┌─────────────┐              (Door 2 — domain fact)
 │ API Service  │   idempotency check via IdempotencyStore (Redis)
 │  (Fastify)   │   auth check via infra-postgres (identity), Redis
 │  (Door 1)    │   read-through cached — see scaling-strategy.md
 └─────────────┘
      └──────────────┬───────────────┘
                      ▼  both produce via MessageBroker port, keyed
                         by recipientId — no outbox, no relay
 ┌───────────────────────────────────────┐
 │          infra-kafka adapter           │
 │  events.critical / .standard / .bulk  │
 └───────────────────────────────────────┘
                      │
                      ▼
              ┌──────────────┐   preferences + quiet hours (Redis-cached,
              │    Router     │   infra-postgres behind) → channel
              │ (composition  │   resolution → template render →
              │     root)     │   publish self-contained command
              └──────────────┘
                      │
                      ▼
 ┌───────────────────────────────────────┐
 │  command.sms / command.push / ...     │
 │  (N partitions, keyed by recipientId) │
 │  + retry-tier topics + DLQ per channel│
 └───────────────────────────────────────┘
      │                    │                    │
      ▼                    ▼                    ▼
 ┌───────────┐       ┌───────────┐       ┌──────────────┐
 │ SMS Worker│       │Push Worker│       │  Status       │  consumes events.*
 │(composition│      │(composition│      │  Projection   │  (accepted) +
 │   root)    │      │   root)    │      │  (single      │  delivery-status
 └───────────┘       └───────────┘       │  writer,      │  (sent/delivered/
      │  dedupe claim       │  dedupe    │  composition   │  failed); ordered
      │  (DedupeRepository) │  claim     │  root)         │  state machine
      ▼                    ▼            └──────────────┘
 SmsGateway port      PushGateway port           │
                                                  ▼
 → providers-sms       → providers-push   ┌──────────────┐
 (Twilio | mock)        (FCM | mock)      │  Postgres    │  NotificationRequest /
      └────────┬───────────┘              │(infra-postgres)│ DeliveryAttempt
               ▼                          └──────────────┘  read model (Phase 1;
   delivery-status published via                            Cassandra at a
   MessageBroker; status queryable via                       measured threshold —
   GET /v1/notifications/:id (eventually                     see scaling-strategy.md)
   consistent with the Kafka log — see ADR 0008/0009)
```

## Components

| Component | Responsibility | Depends on (ports) |
|---|---|---|
| `services/api` | Accept notification intents (Door 1), expose status/preferences/template/feed endpoints, produce to the event backbone | `NotificationRepository` (read-only), `MessageBroker`, `IdempotencyStore`, `RateLimiter` |
| `services/router` | Consume `events.*`; resolve preferences, quiet hours, channel, template; publish self-contained `command.*` | `PreferenceRepository`, `TemplateRepository`, `ScheduledNotificationRepository`, `MessageBroker` |
| `services/scheduler` | Poll `scheduled_notifications` (sharded by `due_minute`, `SKIP LOCKED`), re-emit due rows onto `events.*` | `ScheduledNotificationRepository`, `MessageBroker` |
| `services/fanout-expander` | Resolve a broadcast audience descriptor into work-sized chunks, then chunks into per-recipient events | `MessageBroker` |
| `services/worker-sms` | Consume `command.sms` (+ its retry tiers), claim dedupe, call SMS provider | `DedupeRepository`, `RateLimiter`, `SmsGateway`, `MessageBroker` |
| `services/worker-push` | Consume `command.push` (+ its retry tiers), claim dedupe, call push provider | `DedupeRepository`, `RateLimiter`, `PushGateway`, `MessageBroker` |
| `services/worker-email` | Consume `command.email` (+ its retry tiers), claim dedupe, call email provider | `DedupeRepository`, `RateLimiter`, `EmailGateway`, `MessageBroker` |
| `services/worker-inapp` | Consume `command.in_app` (+ its retry tiers), claim dedupe, write `NotificationFeedItem`, notify `inapp-gateway` via Redis pub/sub | `DedupeRepository`, `RateLimiter`, `NotificationRepository`, `MessageBroker` |
| `services/inapp-gateway` | Stateless — hold the WebSocket connection registry, push feed items to connected recipients | Redis pub/sub |
| `services/projection-notification` | Single writer of `NotificationRequest.status`; consumes `events.*` (accepted) + `delivery-status` (sent/delivered/failed), applies ordered state machine | `NotificationRepository`, `MessageBroker` |
| `domain-notification` | NotificationRequest/DeliveryAttempt/DedupeClaim/ScheduledNotification entities, dispatch orchestration, retry policy, defines repository/broker/gateway ports | none (pure domain) |
| `domain-preferences` | Recipient/Preference/RecipientKey entities, quiet-hours logic, defines `PreferenceRepository`/`RecipientKeyRepository` ports | none (pure domain) |
| `domain-identity` | Tenant/ApiKey entities, rate-limit policy | none (pure domain) |
| `domain-templates` | Template/TemplateVersion entities, defines `TemplateRepository` port | none (pure domain) |
| `infra-postgres` | Implements repository ports for `domain-identity`/`domain-preferences`/`domain-templates`, and — for Phase 1 — `domain-notification`'s `NotificationRepository`/`DedupeRepository`/`ScheduledNotificationRepository`, via Prisma | PostgreSQL |
| `infra-cassandra` | Reserved adapter for `NotificationRepository`/`DedupeRepository`/`NotificationFeedItem`, built when a Phase 1 threshold is crossed — see [`scaling-strategy.md`](scaling-strategy.md#storage-phasing) | Cassandra / ScyllaDB |
| `infra-kafka` | Implements `MessageBroker` port, owns event/command/retry-topic topology | Kafka |
| `infra-redis` | Implements `RateLimiter`, `IdempotencyStore`, and pub/sub (for `inapp-gateway`) ports | Redis |
| `providers-sms` | Implements `SmsGateway` port (Twilio + mock) | Twilio API |
| `providers-push` | Implements `PushGateway` port (FCM + mock) | FCM API |
| `providers-email` | Implements `EmailGateway` port (SES/SendGrid + mock) | SES/SendGrid API |

`services/router`, `services/scheduler`, `services/fanout-expander`, and
`services/inapp-gateway` are new composition roots introduced by
[ADR 0009](../adr/0009-event-backbone-router.md),
[ADR 0011](../adr/0011-scheduling-and-fanout.md), and
[ADR 0012](../adr/0012-inapp-gateway-split.md) respectively — queue
consumers (or, for `inapp-gateway`, a WebSocket-holding process) like
`worker-sms`/`worker-push`, not HTTP services, so they follow the same
"backend process" naming rule from
[ADR 0001](../adr/0001-monorepo-structure.md#terminology).

## Cross-cutting concerns

- **Structured logging** — every request/attempt carries a correlation id
  (the `NotificationRequest` id) through API → queue → worker → provider
  call, for traceability across process boundaries.
- **Metrics** — each service exposes a `/metrics` endpoint (Prometheus
  format), part of the reliability/observability polish in
  [`../roadmap.md`](../roadmap.md)'s Phase 1.
- **Idempotency** — `Idempotency-Key` header deduplicated via
  `IdempotencyStore` (Redis) before a request is persisted.
- **Rate limiting** — token bucket per tenant/channel via `RateLimiter`
  (Redis), enforced in the workers before calling a provider.

See [`domain-model.md`](domain-model.md) for bounded contexts,
[`data-model.md`](data-model.md) for persisted entities,
[`messaging.md`](messaging.md) for the broker topology,
[`infra-strategy.md`](infra-strategy.md) for how this deploys locally and on
free-tier hosting, and [`scaling-strategy.md`](scaling-strategy.md) for how
every component absorbs user-count growth without a redesign.
