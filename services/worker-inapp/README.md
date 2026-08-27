# services/worker-inapp

Consumes `command.in_app` and its retry tiers
(`command.in_app.retry-30s/-5m/-30m`). A **composition root**, but
narrower than `worker-sms`/`worker-push`/`worker-email` since
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md): it claims the
dedupe key and writes a `NotificationFeedItem` (see
[`data-model.md`](../../docs/architecture/data-model.md)) so the
notification is visible later via the feed API — it no longer holds any
WebSocket connection state. After writing the feed row, it publishes over
Redis pub/sub so `services/inapp-gateway` can push to a live connection if
one exists. Also backs `GET /v1/feed/:recipientId` and the read/unread
endpoints (routed through `services/api`, reading the same
`NotificationFeedItem` projection this service writes).

See
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#in-app-is-structurally-different)
for why in-app splits into this service plus `services/inapp-gateway`,
rather than one process holding both the Kafka consumer group and the
socket registry.

**Depends on (ports):** `DedupeRepository`, `NotificationRepository`,
`MessageBroker`, `RateLimiter`.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-channel-rollout.md)).
