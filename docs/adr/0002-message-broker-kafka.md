# ADR 0002: Kafka as the message broker

## Status
In Progress

## Context
Notification dispatch needs async delivery, per-channel routing, retry
with backoff, and dead-lettering after max attempts — and the architecture
has to absorb user-count growth (illustratively, ~100 users at launch to on
the order of 1,000,000 over 3-4 years — see
[`scaling-strategy.md`](../architecture/scaling-strategy.md)) by adding
capacity, never by redesigning the broker at the point it's needed.
Candidates considered: Kafka, RabbitMQ, and a Redis-backed queue (e.g.
BullMQ).

## Decision
Kafka, accessed only through a `MessageBroker` port owned by
`domain-notification` and implemented by `infra-kafka`. Per-channel topics
(`sms.notify`, `push.notify`, `email.notify`, `in_app.notify`), partitioned
by `recipientId`, with one retry topic per backoff tier and a DLQ topic per
channel (see [`messaging.md`](../architecture/messaging.md) for the full
topology). Kafka is also the durable log of record for accepted requests —
the API produces directly to it after an application-level idempotency
check; there is no separate database write in the ingest path (see
[ADR 0008](0008-notification-delivery-cqrs.md)).

## Rationale
- **Partitioned log scales by adding capacity.** A topic's throughput
  ceiling is partition count × per-partition throughput, and consumer
  groups scale by adding replicas — both are infra/config changes, not
  architecture changes. This is the mechanism
  [`scaling-strategy.md`](../architecture/scaling-strategy.md) relies on for
  absorbing user-count growth.
- **Partitioned by `recipientId`, not `tenantId`.** A tenant-keyed
  partition would cap a single large tenant's throughput at one partition's
  capacity regardless of total partition count. Keying by `recipientId`
  keeps one recipient's messages in order (the guarantee that actually
  matters) while spreading any one tenant's traffic across partitions
  automatically, since that tenant's own recipients already hash to
  different keys.
- **Retry/DLQ via a retry-topic-per-backoff-tier pattern.** A failed
  message is produced to `<channel>.notify.retry-30s`, then `retry-5m`, and
  so on, landing on `<channel>.notify.dlq` after `RetryPolicy.maxAttempts`.
  This is more topics than a broker with native per-message TTL/DLX would
  need, but it's a well-established pattern, and it keeps the durability
  and scale-out properties Kafka's partitioned log provides.

## Alternatives considered
- **RabbitMQ**: gives per-message retry/DLQ semantics natively via
  dead-letter exchanges and per-queue TTLs, which is simpler for a single
  broker instance. Rejected because its per-message routing model doesn't
  horizontally partition the way a log does — a queue's throughput doesn't
  scale by adding consumers past what one queue can dispatch, which is
  exactly the ceiling this system is designed to avoid as usage grows.
  RabbitMQ also isn't durable-log-shaped, so it couldn't serve as the
  system of record ADR 0008 relies on without reintroducing a separate
  durable store and the dual-write problem that implies.
- **Redis-backed queue (BullMQ)**: simplest to run (no separate broker),
  but exchange/routing/DLQ topology is a bolted-on convention rather than a
  first-class feature, and a Redis list/stream doesn't give the same
  partition-based horizontal scale-out as a purpose-built log.

## Consequences
- One more piece of infrastructure to run — a Kafka broker locally (KRaft
  mode, no separate Zookeeper needed) and, when the future-work hosted demo
  is taken up, a managed Kafka-protocol service (see
  [`infra-strategy.md`](../architecture/infra-strategy.md)).
- Because the broker is fully behind the `MessageBroker` port, swapping the
  underlying broker later touches only `infra-kafka` and composition-root
  wiring, never `domain-*` code.
- A single-broker, low-partition-count local setup proves the pipeline is
  *correct* end to end; it doesn't demonstrate peak throughput, which is a
  property of partition count and consumer-group size at real load — a
  capacity decision, not a code change.
