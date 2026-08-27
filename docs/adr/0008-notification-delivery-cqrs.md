# ADR 0008: CQRS for notification delivery — Kafka as log, Cassandra as read model

## Status
In Progress

## Context
[ADR 0002](0002-message-broker-kafka.md) and
[ADR 0003](0003-polyglot-persistence.md) establish Kafka as the broker and
a store (Postgres for Phase 1, Cassandra later — see ADR 0003's revision)
as `domain-notification`'s read model. What's not yet decided is how they
fit together: does the API write to a database and separately publish to
Kafka, or is there a single write path? A dual write (database + broker)
needs a coordination mechanism to keep both in sync if one write succeeds
and the other fails — extra machinery, and another moving part that itself
needs to scale with notification volume.

**Amended by [ADR 0009](0009-event-backbone-router.md) and
[ADR 0010](0010-delivery-reliability.md):** this ADR's original text
described the projection consumer as something a worker read from to get
the request payload back. That dependency is removed — see "What changed"
at the bottom. The CQRS decision itself (Kafka as log of record, no dual
write) is unchanged.

## Decision
Kafka is the **durable log of record**. `services/api` deduplicates at the
application level (`IdempotencyStore`, keyed on `tenantId` +
`idempotencyKey` — see [`multi-tenancy.md`](../architecture/multi-tenancy.md))
and then produces directly to the relevant `<channel>.notify` topic, with
the Kafka client's idempotent-producer mode enabled (a broker-session
mechanism guarding against duplicate writes from producer-side retries,
distinct from the application-level dedup key above). There is no database
write in the ingest path — Kafka's own replication is the durability
guarantee.

A **projection consumer** (`services/projection-notification`) reads the
topic and builds the `NotificationRequest`/`DeliveryAttempt` read model in
Cassandra (`NotificationRepository`), upserting idempotently so
at-least-once redelivery never produces duplicate rows. `GET
/v1/notifications/:id` reads this projection. This is CQRS: Kafka is the
write/event side, Cassandra is the read side, and they're populated by two
independent consumer groups so read-model projection scales independently
of dispatch.

## Rationale
- **One write path, no coordination problem.** With Kafka as the sole
  system of record for "this request was accepted," there's nothing to
  keep in sync — a database write that might fail independently of the
  broker publish simply doesn't exist in this design.
- **Read and write scale independently.** `services/worker-sms`/
  `worker-push`/`worker-email`/`worker-inapp` (dispatch) and
  `services/projection-notification` (read-model projection) are separate
  consumer groups on the same topics — either can scale its own replica
  count without affecting the other.
- **Consistency trade-off, stated plainly.** Cassandra is AP-leaning with
  tunable consistency, not transactional — the read model is *eventually*
  consistent with the Kafka log. Immediately after `202 Accepted`, a `GET`
  may briefly 404 until the projection catches up. Mitigated with `QUORUM`
  read/write consistency and idempotent, at-least-once projection
  consumers (dedup by `notificationRequestId` + event type), but not
  eliminated — this is a real cost paid for removing the single-writer
  ceiling a database-first design would have, not a free win.

## Consequences
- `services/api` depends on `NotificationRepository` for reads only
  (`GET /v1/notifications/:id`, `GET /v1/feed/:recipientId`); it never
  writes through that port. All writes go through `MessageBroker`.
- `202 Accepted` on `POST /v1/notifications` means "durably produced to
  the event backbone," not "queryable yet" — see
  [`api-spec.md`](../architecture/api-spec.md) for the exact client-facing
  wording of this trade-off.
- `services/worker-inapp` writes a second, `in_app`-specific projection
  (`NotificationFeedItem`, keyed by `recipientId`) off `command.in_app`,
  since "all unread items for this recipient" needs its own key — see
  [`messaging.md`](../architecture/messaging.md#in-app-is-structurally-different).

## What changed (see ADR 0009, ADR 0010)

Two corrections on top of this ADR's original decision, made before any
code existed against it:

- **The projection is no longer a dependency of the delivery path.**
  Originally, a worker read the request payload back from
  `NotificationRepository` before dispatching — two independent consumer
  groups on the same topic, with no ordering guarantee between them, so
  the worker's normal case was reading a payload that hadn't been written
  yet. [ADR 0009](0009-event-backbone-router.md) fixes this by having the
  router publish a self-contained, fully rendered command — nothing
  downstream of the router reads through `NotificationRepository` to do
  its job. The projection is a read model, full stop; only
  `GET /v1/notifications/:id` depends on it.
- **The projection is the single writer of `status`.** Originally, the
  projection wrote `accepted` and workers wrote `sent`/`delivered`
  independently, which could regress the row under a lagging projection
  (last-write-wins on an eventually consistent store). See
  [ADR 0010](0010-delivery-reliability.md#single-writer-status) — one
  consumer group, both source topics, an ordered state machine.
