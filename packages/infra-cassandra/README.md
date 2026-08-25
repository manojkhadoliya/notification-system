# packages/infra-cassandra

Implements the `NotificationRepository` port defined by
`domain-notification`, using a Cassandra/ScyllaDB driver (the two are
wire-compatible; either can back this adapter). Stores the
`NotificationRequest`/`DeliveryAttempt` read model as described in
[`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md) —
partitioned for write-heavy, id-keyed access with no cross-context joins.

Written to by `services/projection-notification` (projecting the Kafka
event stream) and by `services/worker-sms`/`services/worker-push`/
`services/worker-email`/`services/worker-inapp` (persisting
`DeliveryAttempt` rows). Read by `services/api`'s
`GET /v1/notifications/:id` endpoint — this read is eventually consistent
with the Kafka log, not transactional (see
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md)'s consistency
trade-off).

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** Phase 1. Rationale for Cassandra in
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md); the CQRS pattern
this package's role fits into is in
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md).
