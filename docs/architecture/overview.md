# Architecture Overview

## Goals

- Demonstrate a realistic multi-channel notification pipeline (SMS, Push,
  later Email and In-app) with reliable async delivery.
- Show Domain-Driven Design in practice: bounded contexts, ports and
  adapters, no domain-to-infrastructure coupling.
- Run entirely on local/free-tier infrastructure while remaining structured
  so a later migration to paid, scaled infra touches only adapter packages.

## Component diagram (Phase 1: SMS + Push)

Notification Delivery's hot path is event-driven (Kafka + Cassandra);
Identity & Tenancy / Recipient Preferences stay on Postgres, looked up
during dispatch. See [ADR 0008](../adr/0008-elastic-scale-data-plane.md) for
why the hot path differs from the other two contexts.

```
Client / API consumer
      │  (API key auth, Idempotency-Key header)
      ▼
 ┌─────────────┐   idempotency check via IdempotencyStore (Redis)
 │ API Service  │   auth/rate-limit check via infra-postgres (identity)
 │  (Fastify)   │
 └─────────────┘
      │  produces directly via MessageBroker port (idempotent producer,
      │  keyed on tenantId + idempotencyKey) — no outbox, no relay
      ▼
 ┌───────────────────────────────────────┐
 │          infra-kafka adapter           │
 │  topic: sms.notify / push.notify      │
 │  (N partitions, keyed by tenantId)    │
 │  + retry-tier topics + DLQ topic      │
 │  per channel                          │
 └───────────────────────────────────────┘
      │                    │                    │
      ▼                    ▼                    ▼
 ┌───────────┐       ┌───────────┐       ┌──────────────┐
 │ SMS Worker│       │Push Worker│       │  Projection  │  domain dispatch:
 │(composition│      │(composition│      │  consumer     │  preference check
 │   root)    │      │   root)    │      │  (composition │  (infra-postgres) →
 └───────────┘       └───────────┘       │     root)     │  rate limit (Redis) →
      │                    │             └──────────────┘  gateway port → persist
      ▼                    ▼                    │          attempt (retry +
 SmsGateway port      PushGateway port           ▼          backoff + breaker)
 → providers-sms       → providers-push   ┌──────────────┐
 (Twilio | mock)        (FCM | mock)      │  Cassandra   │  NotificationRequest /
      └────────┬───────────┘              │(infra-cassandra)│ DeliveryAttempt
               ▼                          └──────────────┘  read model
   DeliveryAttempt persisted via NotificationRepository port
   (Cassandra); status queryable via GET /v1/notifications/:id
   (eventually consistent with the Kafka log — see ADR 0008)
```

## Components

| Component | Responsibility | Depends on (ports) |
|---|---|---|
| `services/api` | Accept notification requests, expose status/preferences endpoints, produce directly to Kafka | `NotificationRepository` (read-only, status queries), `PreferenceRepository`, `MessageBroker`, `IdempotencyStore`, `RateLimiter` |
| `services/worker-sms` | Consume `sms.notify` topic, run dispatch, call SMS provider | `NotificationRepository`, `PreferenceRepository`, `RateLimiter`, `SmsGateway` |
| `services/worker-push` | Consume `push.notify` topic, run dispatch, call push provider | `NotificationRepository`, `PreferenceRepository`, `RateLimiter`, `PushGateway` |
| `services/projection-notification` | Project `sms.notify`/`push.notify` events into the Cassandra read model | `NotificationRepository`, `MessageBroker` |
| `domain-notification` | NotificationRequest/DeliveryAttempt entities, dispatch orchestration, retry policy, defines repository/broker/gateway ports | none (pure domain) |
| `domain-preferences` | Recipient/Preference entities, quiet-hours logic, defines `PreferenceRepository` port | none (pure domain) |
| `domain-identity` | Tenant/ApiKey entities, rate-limit policy | none (pure domain) |
| `infra-postgres` | Implements repository ports for `domain-identity`/`domain-preferences` via Prisma | PostgreSQL |
| `infra-cassandra` | Implements `NotificationRepository` for `domain-notification` (read-model projection) | Cassandra / ScyllaDB |
| `infra-kafka` | Implements `MessageBroker` port, owns topic/partition/retry-topic topology | Kafka |
| `infra-redis` | Implements `RateLimiter` and `IdempotencyStore` ports | Redis |
| `providers-sms` | Implements `SmsGateway` port (Twilio + mock) | Twilio API |
| `providers-push` | Implements `PushGateway` port (FCM + mock) | FCM API |

`services/projection-notification` is a new composition root introduced by
[ADR 0008](../adr/0008-elastic-scale-data-plane.md) — it is a queue-consumer
worker like `worker-sms`/`worker-push`, not an HTTP service, so it follows
the same "backend process" naming rule from
[ADR 0001](../adr/0001-monorepo-structure.md#terminology).

## Cross-cutting concerns

- **Structured logging** — every request/attempt carries a correlation id
  (the `NotificationRequest` id) through API → queue → worker → provider
  call, for traceability across process boundaries.
- **Metrics** — each service exposes a `/metrics` endpoint (Prometheus
  format), added in Phase 3.
- **Idempotency** — `Idempotency-Key` header deduplicated via
  `IdempotencyStore` (Redis) before a request is persisted.
- **Rate limiting** — token bucket per tenant/channel via `RateLimiter`
  (Redis), enforced in the workers before calling a provider.

See [`domain-model.md`](domain-model.md) for bounded contexts,
[`data-model.md`](data-model.md) for persisted entities,
[`messaging.md`](messaging.md) for the broker topology, and
[`infra-strategy.md`](infra-strategy.md) for how this deploys locally and on
free-tier hosting.
