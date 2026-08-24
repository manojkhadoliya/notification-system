# packages/infra-rabbitmq

Implements the `MessageBroker` port defined by `domain-notification`, using
`amqplib` against RabbitMQ. Owns the exchange/queue/retry-delay/DLQ
topology setup (see
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)).
Used by the outbox relay in `apps/api` to publish, and by
`apps/worker-sms`/`apps/worker-push` to consume.

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** Phase 1. Rationale for RabbitMQ in
[ADR 0002](../../docs/adr/0002-queue-choice-rabbitmq.md).
