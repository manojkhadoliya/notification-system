# Messaging — RabbitMQ Topology

Accessed only through the domain-owned `MessageBroker` port
(`domain-notification`); implemented by `infra-rabbitmq`. Workers and the
API never talk to `amqplib` directly.

## Why RabbitMQ (not Kafka) for Phase 1

Per-channel queues, dead-letter exchanges, and TTL-based delayed retry map
directly onto "deliver this notification, retrying with backoff, then give
up." Kafka is a log built for streaming/replay, not a task queue — it would
need extra plumbing to get equivalent per-message retry/DLQ behavior, and
is heavier to run for free. Kafka is left as an optional Phase 3+ addition
for audit/event-replay, layered on top of RabbitMQ rather than replacing
it. Because the broker sits behind a port, this decision can change later
without touching domain or worker application logic. Full rationale in
[ADR 0002](../adr/0002-queue-choice-rabbitmq.md).

## Exchange/queue layout

```
exchange: notifications (topic)

routing key: sms.notify        → queue: sms.notify
routing key: push.notify       → queue: push.notify

Each queue has:
  - a retry-delay queue (per-message TTL, dead-letters back to the main
    queue on expiry) implementing exponential backoff without a
    delayed-message plugin
  - a dead-letter queue (sms.notify.dlq / push.notify.dlq) for messages
    that exhaust the RetryPolicy's max attempts
```

## Message flow

1. API writes `NotificationRequest` + `Outbox` row in one DB transaction.
2. Outbox relay reads unpublished outbox rows, publishes to the
   `notifications` exchange with routing key `<channel>.notify`, marks the
   row published.
3. The matching worker (`worker-sms` / `worker-push`) consumes, runs the
   domain dispatch service: preference check → rate limit → call the
   channel gateway port.
4. On success: `DeliveryAttempt` persisted as `sent` (later `delivered` via
   webhook, for SMS), message acked.
5. On failure: message nacked and republished to the retry-delay queue with
   a TTL from `RetryPolicy`; on expiry it dead-letters back to the main
   queue for another attempt.
6. After `RetryPolicy.maxAttempts`, the message is routed to the DLQ
   instead of being retried again. A Phase 3 admin endpoint allows
   inspecting/replaying DLQ messages.

## Message envelope

```json
{
  "notificationRequestId": "uuid",
  "tenantId": "uuid",
  "channel": "sms",
  "attemptNumber": 1
}
```

Kept intentionally thin — the worker loads the full request from Postgres
via `NotificationRepository` rather than trusting a payload duplicated into
the queue, avoiding a second source of truth for request content.

## Consumer guarantees

- Manual ack mode: a message is only acked after the `DeliveryAttempt` is
  durably persisted, so a worker crash mid-dispatch results in redelivery,
  not silent loss.
- `NotificationRequest` processing is expected to be idempotent per attempt
  (attempt is keyed by `notificationRequestId` + `attemptNumber`), so a
  redelivered message that already succeeded is a safe no-op.
