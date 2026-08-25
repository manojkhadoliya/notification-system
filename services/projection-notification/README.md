# services/projection-notification

Consumes the `sms.notify`/`push.notify`/`email.notify` topics and projects
accepted requests into the Cassandra-backed read model. A **composition
root**: no business logic, just an upsert of `NotificationRequest` (status
`accepted`) via `NotificationRepository` for every event consumed,
idempotent under Kafka's at-least-once redelivery.

This is the "C" side of the CQRS split described in
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md): `services/api`
writes only to Kafka; this process is what makes an accepted request
visible to `GET /v1/notifications/:id` at all. It runs independently of
`services/worker-sms`/`services/worker-push`/`services/worker-email`
(separate consumer group) so dispatch and read-model projection scale
independently.

**Depends on (ports):** `NotificationRepository`, `MessageBroker`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See [`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)
for the consumer-group layout.
