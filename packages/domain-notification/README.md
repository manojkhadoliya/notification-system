# packages/domain-notification

Core domain of the system: the **Notification Delivery** bounded context.
Owns the `NotificationRequest`/`DeliveryAttempt`/`DedupeClaim`/
`ScheduledNotification` entities, the routing decision (`RoutingDecision`
— channel resolution, quiet-hours deferral, template render, consumed by
`services/router`), the dispatch orchestration service (dedupe claim →
rate limit → send → persist, consumed by the channel workers), and the
`RetryPolicy`. Defines the ports (`NotificationRepository`,
`DedupeRepository`, `ScheduledNotificationRepository`, `MessageBroker`,
`SmsGateway`, `PushGateway`, ...) that infrastructure packages implement.
See [ADR 0009](../../docs/adr/0009-event-backbone-router.md),
[ADR 0010](../../docs/adr/0010-delivery-reliability.md), and
[ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md).

**Contains zero imports of Prisma, a Kafka client, a Cassandra driver, or any
provider SDK** — that's the whole point (see
[ADR 0005](../../docs/adr/0005-ddd-hexagonal-architecture.md)). Testable in
isolation with in-memory fake adapters.

**Implemented by:** `infra-postgres` (Phase 1), `infra-cassandra`
(deferred — see [`scaling-strategy.md`](../../docs/architecture/scaling-strategy.md#storage-phasing)),
`infra-kafka`, `providers-sms`, `providers-push`.

**Delivered in:** Phase 1. Full model in
[`../../docs/architecture/domain-model.md`](../../docs/architecture/domain-model.md).
