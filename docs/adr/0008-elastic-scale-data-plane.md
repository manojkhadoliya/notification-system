# ADR 0008: Event-driven data plane for elastic peak scale

## Status
Accepted (supersedes [ADR 0002](0002-queue-choice-rabbitmq.md)'s broker
choice; supersedes [ADR 0003](0003-database-postgres.md)'s datastore choice
for the `domain-notification` context only)

## Context
ADR 0002/0003/0006 were made against a "portfolio, local/free-tier" scope,
which produced a single-writer data plane: one Postgres primary holds the
transactional outbox, one RabbitMQ cluster carries dispatch traffic. That's
appropriate for demo-scale load, but it has a real ceiling — a single
Postgres primary tops out somewhere in the thousands-to-low-tens-of-
thousands of transactions/sec, and RabbitMQ's per-message routing model
doesn't horizontally partition the way a log does.

The requirement isn't a fixed peak-throughput number — it's that the
architecture should absorb **user-count growth** (illustratively, ~100
users at launch to on the order of 1,000,000 over 3-4 years — see
[`scaling-strategy.md`](../architecture/scaling-strategy.md) for the full
growth curve and per-component headroom analysis) the way real
notification/messaging platforms do in industry: scale out horizontally as
usage grows, without an infrastructure redesign at the moment it's needed.
A single-writer relational primary can't do that no matter how it's tuned —
scaling it means changing what it *is*, not how big it is.

## Decision
For the `domain-notification` bounded context (the hot path — every
notification send touches it):

1. **RabbitMQ → Kafka** as the implementation behind the `MessageBroker`
   port (`infra-kafka`, replacing `infra-rabbitmq`). Kafka's partitioned log
   is what makes "scale out during a burst" a partition-count and
   consumer-group-size change instead of an architecture change, and it's
   the broker actually used for this pattern across the industry today.
2. **The transactional outbox is retired for this context.** The outbox
   pattern exists solely to solve the dual-write problem between Postgres
   and a broker. Kafka becomes the durable log of record instead: the API
   deduplicates at the application level via `IdempotencyStore`
   (`tenantId` + `idempotencyKey`, see
   [`multi-tenancy.md`](../architecture/multi-tenancy.md)) and then produces
   directly to Kafka with the client's idempotent-producer mode enabled
   (Kafka's own duplicate-write protection against producer-side retries —
   a broker-session mechanism, distinct from the application-level dedup
   key). Kafka's replication is the durability guarantee; there is no
   second system to keep in sync, so there's no dual-write problem left to
   solve.
3. **`NotificationRepository` (the read/status side) is backed by a
   wide-column store (Cassandra or ScyllaDB — wire-compatible, pick either)
   via a new `infra-cassandra` package**, populated by consumer processes
   that project the Kafka event stream into `NotificationRequest` /
   `DeliveryAttempt` rows. This is CQRS: Kafka is the write/event side,
   Cassandra is the read side.

`domain-identity` and `domain-preferences` **keep Postgres**, unchanged from
ADR 0003. Their write volume (tenant/API-key provisioning, preference
updates) never approaches the notification-send hot path, so moving them
would be change with no driving business or scale reason — exactly what the
[business-logic/infra boundary test](../architecture/domain-model.md#where-does-new-logic-belong)
already argues against. Each bounded context owns its persistence behind its
own port (ADR 0005); nothing requires every context to share one database
technology, and this is a deliberate example of that: **polyglot
persistence, chosen per context's actual access pattern, not applied
system-wide.**

Retry/DLQ semantics move from RabbitMQ's native TTL/DLX to the standard
**retry-topic-per-backoff-tier** Kafka pattern: a failed message is produced
to `sms.notify.retry-30s`, then `sms.notify.retry-5m`, and so on, landing on
`sms.notify.dlq` after `RetryPolicy.maxAttempts` — more topics than
RabbitMQ's single DLX gave for free, but a well-established pattern, not a
gap.

## Rationale
- **Why not just scale Postgres/RabbitMQ harder?** Read replicas don't help
  a write-path ceiling, and a single-writer primary's throughput ceiling is
  a property of the write model, not the hardware under it. This is the
  actual distinction between "scale via infra" and "scale via architecture
  change" raised when this decision was made.
- **Why not distributed SQL (CockroachDB/Citus) instead of a wide-column
  store?** Considered. Distributed SQL keeps ACID transactions and is a
  smaller conceptual jump from Postgres, which is real value. Rejected for
  this specific hot path because `NotificationRequest`/`DeliveryAttempt`'s
  access pattern — write once, read by id, no joins (already disallowed
  across contexts by the context map) — doesn't need transactional
  guarantees across rows, and the coordination cost distributed SQL pays to
  offer them anyway is exactly the overhead a wide-column store skips. If a
  future context ever needs cross-row transactional guarantees at scale,
  distributed SQL is the right tool for *that* context — this isn't a
  system-wide verdict against it.
- **Why is this a new ADR instead of editing 0002/0003 in place?** Those
  ADRs made a materially correct call for the scope they were written
  against (see their own Rationale sections). Superseding them explicitly,
  rather than rewriting history, keeps the record of *why* the original
  choice was made and *why* it changed — the evolution itself is a more
  honest artifact than pretending the first call was wrong.
- **Consistency trade-off, stated plainly:** Cassandra/Scylla are AP-leaning
  with tunable consistency, not transactional. `GET /v1/notifications/:id`
  reads a projection that is *eventually* consistent with the Kafka log —
  immediately after a `202 Accepted`, the projection may not have caught up
  yet. Mitigated with `QUORUM` read/write consistency and idempotent,
  at-least-once projection consumers (dedup by
  `notificationRequestId` + event type), but not eliminated. This is a real
  cost being paid for the throughput ceiling this ADR removes, not a free
  win.
- **What this does *not* fix:** real SMS/push providers (Twilio, FCM) have
  their own throughput limits far below any of the numbers this ADR is
  concerned with. Internally the system can now accept and orchestrate at
  a much higher, elastically-scaling rate; actually *delivering* at that
  rate against a real provider is a partnerships/multi-account problem no
  software architecture solves.

## Consequences
- New/renamed packages: `infra-kafka` (renamed from `infra-rabbitmq`),
  new `infra-cassandra`. `infra-postgres`'s scope narrows to
  `domain-identity`, `domain-preferences`, and `domain-templates` — every
  Postgres-backed context except the notification-delivery hot path.
- [`messaging.md`](../architecture/messaging.md) rewritten for Kafka
  topics/partitions/consumer groups/retry-topics, replacing the
  exchange/queue/DLX topology.
- [`data-model.md`](../architecture/data-model.md)'s `Outbox` table is
  removed — there's no second write to reconcile.
- [`api-spec.md`](../architecture/api-spec.md)'s `202 Accepted` on
  `POST /v1/notifications` now means "durably produced to Kafka," not
  "written to Postgres"; `GET /v1/notifications/:id` reads the
  Cassandra-backed projection and inherits its eventual-consistency window.
- [ADR 0006](0006-local-first-free-tier-infra.md)'s local-first story is
  reframed, not broken: `docker compose up` with a single-broker Kafka and
  single-node Cassandra/Scylla still proves the pipeline is *correct*
  end-to-end. It cannot prove the *peak-throughput number* — demonstrating
  that would need real infrastructure to load-test, which stays out of
  scope. Free-tier hosted equivalents exist for the future-work hosted demo
  (Confluent Cloud / Upstash Kafka; DataStax Astra for Cassandra), updated
  in [`infra-strategy.md`](../architecture/infra-strategy.md).
- More upfront infrastructure to run even locally (two new moving parts
  instead of one broker) — accepted for the same reason the DDD/hexagonal
  structure itself was accepted: demonstrating this judgment is the point
  of the project.
- Elastic peak-handling is proven by *design* (partition count + autoscaling
  consumer groups), not by a benchmark number — the Phase 1 load test
  (`roadmap.md`) demonstrates the scale-out mechanism working, not a
  specific throughput target.
- The Kafka topic partition key is `recipientId`, not `tenantId` — a single
  large tenant's traffic would otherwise be capped at one partition's
  throughput regardless of total partition count. See
  [`scaling-strategy.md`](../architecture/scaling-strategy.md#why-the-kafka-partition-key-is-recipientid-not-tenantid)
  for why, and [`messaging.md`](../architecture/messaging.md) for the topic
  layout.
- [`scaling-strategy.md`](../architecture/scaling-strategy.md) is the
  full per-component growth story (this ADR covers *why* Kafka+Cassandra;
  that doc covers *how every layer, including the Postgres-backed
  contexts, absorbs growth without redesign*).
