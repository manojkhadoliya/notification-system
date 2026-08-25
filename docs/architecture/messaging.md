# Messaging — Kafka Topology

Accessed only through the domain-owned `MessageBroker` port
(`domain-notification`); implemented by `infra-kafka`. Workers and the API
never talk to a Kafka client library directly.

## Why Kafka (superseding RabbitMQ)

[ADR 0002](../adr/0002-queue-choice-rabbitmq.md) chose RabbitMQ for its
native per-message retry/DLQ semantics, at portfolio/local-first scope.
[ADR 0008](../adr/0008-elastic-scale-data-plane.md) supersedes that: the
requirement became elastic peak scale-out — absorb a large traffic burst by
adding partitions/consumers, not by redesigning the broker at the moment
it's needed. Kafka's partitioned log is what makes that a capacity change
instead of an architecture change, and it's also now the durable log of
record for accepted requests (see "Message flow" below) — RabbitMQ was
never meant to be a system of record.

## Topic layout

```
topic: sms.notify        (N partitions, keyed by tenantId)
topic: push.notify       (N partitions, keyed by tenantId)

Retry, per channel, one topic per backoff tier (replaces RabbitMQ's
per-queue TTL + dead-letter exchange):
  sms.notify.retry-30s   sms.notify.retry-5m   sms.notify.dlq
  push.notify.retry-30s  push.notify.retry-5m  push.notify.dlq
```

Partitioning by `tenantId` keeps all of one tenant's messages in order on
one partition (useful for debugging and per-tenant rate reasoning) while
still allowing the topic to scale out by adding partitions and consumers as
tenant count/volume grows — this is the mechanism behind "scale out during a
peak without a redesign."

## Message flow

1. API validates the request (auth, rate limit, idempotency check via
   `IdempotencyStore`) and produces directly to `<channel>.notify` with an
   **idempotent producer** keyed on `(tenantId, idempotencyKey)`. There is no
   Postgres write in this path and no outbox relay — Kafka's replication
   *is* the durability guarantee (see [ADR 0008](../adr/0008-elastic-scale-data-plane.md)).
2. A projection consumer reads `<channel>.notify` and writes the initial
   `NotificationRequest` row (status `accepted`) into the Cassandra-backed
   read model via `NotificationRepository`.
3. The matching worker (`worker-sms` / `worker-push`) consumes the same
   topic (separate consumer group), runs the domain dispatch service:
   preference check → rate limit → call the channel gateway port.
4. On success: `DeliveryAttempt` persisted as `sent` (later `delivered` via
   webhook, for SMS) through `NotificationRepository`, offset committed.
5. On failure: the message is produced to that channel's next retry-tier
   topic with the delay implied by `RetryPolicy`; a lightweight delay-aware
   consumer on each retry topic re-produces back to the main topic once the
   delay has elapsed.
6. After `RetryPolicy.maxAttempts`, the message is produced to the DLQ topic
   instead of being retried again. A Phase 3 admin endpoint allows
   inspecting/replaying DLQ messages — Kafka's log retention makes replay a
   native capability here, not a bolt-on.

## Message envelope

```json
{
  "notificationRequestId": "uuid",
  "tenantId": "uuid",
  "channel": "sms",
  "idempotencyKey": "string",
  "attemptNumber": 1
}
```

Kept intentionally thin — the worker loads the full request payload from the
`NotificationRepository` (Cassandra) rather than trusting a payload
duplicated into the message, avoiding a second source of truth for request
content.

## Consumer guarantees

- Manual offset commit: an offset is only committed after the
  `DeliveryAttempt` is durably persisted, so a worker crash mid-dispatch
  results in redelivery (Kafka's at-least-once default), not silent loss.
- Dispatch processing is idempotent per attempt (attempt is keyed by
  `notificationRequestId` + `attemptNumber`), so redelivery of an
  already-succeeded message is a safe no-op.
- Projection consumers (step 2 above) are equally idempotent, since the same
  at-least-once guarantee applies to them — a redelivered "accepted" event
  is an upsert, not a duplicate row.

## What local dev proves vs. what it doesn't

A single-broker Kafka container (Docker Compose) with a handful of
partitions proves the pipeline is *correct* end-to-end — ordering, retry
tiers, idempotent production/consumption. It does not, by itself,
demonstrate peak throughput; that's a property of partition count and
consumer-group size at real load, which is a capacity/hosting decision, not
a code change. See [ADR 0008](../adr/0008-elastic-scale-data-plane.md).
