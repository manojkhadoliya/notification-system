# Architecture Overview

## Goals

- Demonstrate a realistic multi-channel notification pipeline (SMS, Push,
  later Email and In-app) with reliable async delivery.
- Show Domain-Driven Design in practice: bounded contexts, ports and
  adapters, no domain-to-infrastructure coupling.
- Run entirely on local/free-tier infrastructure while remaining structured
  so a later migration to paid, scaled infra touches only adapter packages.

## Component diagram (Phase 1: SMS + Push)

```
Client / API consumer
      │  (API key auth, Idempotency-Key header)
      ▼
 ┌─────────────┐     ┌──────────────┐
 │ API Service  │────▶│  PostgreSQL  │  via NotificationRepository port →
 │  (Fastify)   │     └──────────────┘  infra-postgres adapter. Outbox row
 └─────────────┘                        written in the same transaction.
      │  outbox relay publishes via MessageBroker port
      ▼
 ┌───────────────────────────────────────┐
 │        infra-rabbitmq adapter          │
 │  exchange: notifications (topic)      │
 │  routing: sms.*, push.*  → per-channel│
 │  queue, each with a retry-delay queue │
 │  and a dead-letter queue              │
 └───────────────────────────────────────┘
      │                    │
      ▼                    ▼
 ┌───────────┐       ┌───────────┐
 │ SMS Worker│       │Push Worker│   domain dispatch service: preference
 │(composition│      │(composition│   check → rate limit → send via gateway
 │   root)    │      │   root)    │   port → persist attempt, with retry
 └───────────┘       └───────────┘   + backoff + circuit breaker
      │                    │
      ▼                    ▼
 SmsGateway port      PushGateway port
 → providers-sms       → providers-push
 (Twilio | mock)        (FCM | mock)
      └────────┬───────────┘
               ▼
   DeliveryAttempt persisted via NotificationRepository port
   status queryable via GET /v1/notifications/:id
```

## Components

| Component | Responsibility | Depends on (ports) |
|---|---|---|
| `services/api` | Accept notification requests, expose status/preferences endpoints, relay outbox to broker | `NotificationRepository`, `PreferenceRepository`, `MessageBroker`, `IdempotencyStore`, `RateLimiter` |
| `services/worker-sms` | Consume `sms.*` queue, run dispatch, call SMS provider | `NotificationRepository`, `PreferenceRepository`, `RateLimiter`, `SmsGateway` |
| `services/worker-push` | Consume `push.*` queue, run dispatch, call push provider | `NotificationRepository`, `PreferenceRepository`, `RateLimiter`, `PushGateway` |
| `domain-notification` | NotificationRequest/DeliveryAttempt entities, dispatch orchestration, retry policy, defines repository/broker/gateway ports | none (pure domain) |
| `domain-preferences` | Recipient/Preference entities, quiet-hours logic, defines `PreferenceRepository` port | none (pure domain) |
| `domain-identity` | Tenant/ApiKey entities, rate-limit policy | none (pure domain) |
| `infra-postgres` | Implements repository ports via Prisma | PostgreSQL |
| `infra-rabbitmq` | Implements `MessageBroker` port, owns queue/exchange topology | RabbitMQ |
| `infra-redis` | Implements `RateLimiter` and `IdempotencyStore` ports | Redis |
| `providers-sms` | Implements `SmsGateway` port (Twilio + mock) | Twilio API |
| `providers-push` | Implements `PushGateway` port (FCM + mock) | FCM API |

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
