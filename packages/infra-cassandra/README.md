# packages/infra-cassandra

**Reserved, not built in Phase 1.** Will implement
`domain-notification`'s `NotificationRepository`/`DedupeRepository`/
`NotificationFeedItem` storage using a Cassandra/ScyllaDB driver (the two
are wire-compatible; either can back this adapter), once a write-volume
threshold is actually crossed — see
[`../../docs/architecture/scaling-strategy.md`](../../docs/architecture/scaling-strategy.md#storage-phasing).
For Phase 1, those same ports are implemented by `infra-postgres` instead
(see [ADR 0003](../../docs/adr/0003-polyglot-persistence.md), revised) —
this package's existence now, as an empty reserved adapter, is what makes
that future move a connection-string change behind an existing port rather
than an application rewrite.

When built: stores the `NotificationRequest`/`DeliveryAttempt` read model
as described in
[`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md) —
partitioned for write-heavy, id-keyed access with no cross-context joins.
Written to by `services/projection-notification` (the single writer of
`status`) and the channel workers (persisting `DeliveryAttempt` rows and
`DedupeClaim`s). Read by `services/api`'s `GET /v1/notifications/:id` —
eventually consistent with the Kafka log, not transactional (see
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md)'s
consistency trade-off).

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** future work — see
[`../../docs/roadmap.md`](../../docs/roadmap.md#future-work-not-phased--introduce-later-if-needed).
Rationale for Cassandra as the eventual store in
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md); the CQRS pattern
this package's role fits into is in
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md).
