# packages/domain-notification

Core domain of the system: the **Notification Delivery** bounded context.
Owns the `NotificationRequest`/`DeliveryAttempt` entities, the dispatch
orchestration service (preference check → rate limit → send → persist),
and the `RetryPolicy`. Defines the ports (`NotificationRepository`,
`MessageBroker`, `SmsGateway`, `PushGateway`, ...) that infrastructure
packages implement.

**Contains zero imports of Prisma, a Kafka client, a Cassandra driver, or any
provider SDK** — that's the whole point (see
[ADR 0005](../../docs/adr/0005-ddd-hexagonal-architecture.md)). Testable in
isolation with in-memory fake adapters.

**Implemented by:** `infra-cassandra`, `infra-kafka`, `providers-sms`,
`providers-push`.

**Delivered in:** Phase 1. Full model in
[`../../docs/architecture/domain-model.md`](../../docs/architecture/domain-model.md).
