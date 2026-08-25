# Messaging — Kafka Topology

Accessed only through the domain-owned `MessageBroker` port
(`domain-notification`); implemented by `infra-kafka`. Workers and the API
never talk to a Kafka client library directly.

## Why Kafka

[ADR 0002](../adr/0002-message-broker-kafka.md) picks Kafka so that
absorbing a traffic burst is a partition/consumer capacity change, not a
broker redesign. [ADR 0008](../adr/0008-notification-delivery-cqrs.md)
builds on that: Kafka is also the durable log of record for accepted
requests (see "Message flow" below), not just a dispatch mechanism.

## Topic layout

```
topic: sms.notify        (N partitions, keyed by recipientId)
topic: push.notify       (N partitions, keyed by recipientId)
topic: email.notify      (N partitions, keyed by recipientId)
topic: in_app.notify     (N partitions, keyed by recipientId)

Retry, per channel, one topic per backoff tier (replaces RabbitMQ's
per-queue TTL + dead-letter exchange):
  sms.notify.retry-30s     sms.notify.retry-5m     sms.notify.dlq
  push.notify.retry-30s    push.notify.retry-5m    push.notify.dlq
  email.notify.retry-30s   email.notify.retry-5m   email.notify.dlq
  in_app.notify.retry-30s  in_app.notify.retry-5m  in_app.notify.dlq
```

`in_app.notify` is consumed by `services/worker-inapp` instead of a
`worker-*` following the SMS/Push/Email pattern exactly — see "In-app is
structurally different" below.

Partitioned by `recipientId`, not `tenantId`: this keeps one recipient's
messages in order on one partition (the ordering guarantee that actually
matters), while spreading a single large tenant's traffic across many
partitions automatically, since that tenant's own recipients already hash
to different keys. Partitioning by `tenantId` instead would cap a large
tenant's throughput at one partition's capacity no matter how many
partitions the topic has — see
[`scaling-strategy.md`](scaling-strategy.md#why-the-kafka-partition-key-is-recipientid-not-tenantid)
for the full reasoning. This is the mechanism behind "scale out with user
growth without a redesign."

## Message flow

1. API validates the request (auth, rate limit, application-level dedup via
   `IdempotencyStore` on `tenantId` + `idempotencyKey`) and produces
   directly to `<channel>.notify`, keyed by `recipientId`, with the Kafka
   client's idempotent-producer mode enabled (guards against duplicate
   writes from producer-side retries — a broker-session mechanism, separate
   from the application-level dedup key above). There is no Postgres write
   in this path and no outbox relay — Kafka's replication *is* the
   durability guarantee (see [ADR 0008](../adr/0008-notification-delivery-cqrs.md)).
2. A projection consumer reads `<channel>.notify` and writes the initial
   `NotificationRequest` row (status `accepted`) into the Cassandra-backed
   read model via `NotificationRepository`.
3. The matching worker (`worker-sms` / `worker-push` / `worker-email`, or
   `worker-inapp` for `in_app` — see below) consumes the same topic
   (separate consumer group), runs the domain dispatch service: preference
   check → rate limit → call the channel gateway port. If the request
   references a `templateVersionId`, the dispatch service renders it via
   `domain-templates`' `TemplateRepository` before calling the gateway.
4. On success: `DeliveryAttempt` persisted as `sent` (later `delivered` via
   webhook, for SMS) through `NotificationRepository`, offset committed.
5. On failure: the message is produced to that channel's next retry-tier
   topic with the delay implied by `RetryPolicy`; a lightweight delay-aware
   consumer on each retry topic re-produces back to the main topic once the
   delay has elapsed.
6. After `RetryPolicy.maxAttempts`, the message is produced to the DLQ topic
   instead of being retried again. An admin endpoint (see
   [`../roadmap.md`](../roadmap.md)) allows inspecting/replaying DLQ
   messages — Kafka's log retention makes replay a native capability here,
   not a bolt-on.

## In-app is structurally different

SMS/Push/Email are fire-and-forget: dispatch calls an external provider and
records the result. In-app has no external provider — `InAppGateway` means
"deliver to a live WebSocket connection if the recipient has one, and
always write a `NotificationFeedItem` (see
[`data-model.md`](data-model.md)) so it's visible later regardless." So
`worker-inapp` does two things `worker-sms`/`worker-push`/`worker-email`
don't: it holds the WebSocket connection registry (which recipient is
connected to which instance — needed for the push half), and it's the
writer for the `NotificationFeedItem` projection (the read half, consumed
by `GET /v1/feed/:recipientId`). It's still a `services/*` composition
root, not business logic — connection routing and feed writes are
mechanical, the "should this recipient see this" decision already happened
in `domain-preferences` before the message reached this topic.

## Message envelope

```json
{
  "notificationRequestId": "uuid",
  "tenantId": "uuid",
  "recipientId": "uuid",
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
a code change. See [ADR 0002](../adr/0002-message-broker-kafka.md).
