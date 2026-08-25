# ADR 0002: RabbitMQ as the message broker

## Status
Accepted for the portfolio/local-first scope this ADR was written against.
Superseded by [ADR 0008](0008-elastic-scale-data-plane.md), which replaces
RabbitMQ with Kafka to support elastic peak scale-out. Rationale below is
kept intact as the record of why RabbitMQ was the right call for that
earlier scope.

## Context
Notification dispatch needs async delivery, per-channel routing, retry
with backoff, and dead-lettering after max attempts. Candidates considered:
RabbitMQ, Kafka, and a Redis-backed queue (e.g. BullMQ).

## Decision
RabbitMQ, accessed only through a `MessageBroker` port owned by
`domain-notification` and implemented by `infra-rabbitmq`.

## Rationale
- **vs. Kafka**: Kafka is a log built for streaming and replay, not a task
  queue. Per-message retry/DLQ semantics (what this system actually needs)
  require extra plumbing on Kafka that RabbitMQ gives natively via
  dead-letter exchanges and per-queue TTLs. Kafka also has a heavier local
  footprint and thinner free hosting tiers, which conflicts with the
  local/free-tier infra constraint (see
  [`infra-strategy.md`](../architecture/infra-strategy.md)). Kafka remains
  attractive as a *later, additive* event-sourcing/audit backbone (Phase
  3+), not as the Phase 1 dispatch mechanism.
- **vs. Redis-backed queue (BullMQ)**: simpler to run (no separate broker),
  but exchanges/routing keys/DLQ topology are bolted-on conventions rather
  than first-class broker features, and it doesn't demonstrate AMQP
  concepts. RabbitMQ better fits the "distributed systems showcase" goal.

## Consequences
- One more moving part to run locally (mitigated: official Docker image,
  included in `docker-compose.yml`) and to host for the free-tier demo
  (mitigated: CloudAMQP free tier).
- Because the broker is fully behind the `MessageBroker` port, this
  decision is reversible later without touching domain or worker
  application code — only `infra-rabbitmq` and composition-root wiring
  would change.
