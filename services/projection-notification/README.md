# services/projection-notification

Consumes the `sms.notify`/`push.notify` topics and projects accepted
requests into the Cassandra-backed read model. A **composition root**: no
business logic, just an upsert of `NotificationRequest` (status `accepted`)
via `NotificationRepository` for every event consumed, idempotent under
Kafka's at-least-once redelivery.

This is the "C" side of the CQRS split introduced by
[ADR 0008](../../docs/adr/0008-elastic-scale-data-plane.md): `services/api`
writes only to Kafka; this process is what makes an accepted request
visible to `GET /v1/notifications/:id` at all. It runs independently of
`services/worker-sms`/`services/worker-push` (separate consumer group) so
dispatch and read-model projection scale independently.

**Depends on (ports):** `NotificationRepository`, `MessageBroker`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See [`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)
for the consumer-group layout.
