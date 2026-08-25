# services/worker-inapp

Consumes the `in_app.notify` topic. A **composition root**, but
structurally different from `worker-sms`/`worker-push`/`worker-email` — see
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#in-app-is-structurally-different):
there's no external provider to call. It does two things instead: pushes to
the recipient's live WebSocket connection if one exists (Socket.io), and
always writes a `NotificationFeedItem` (see
[`data-model.md`](../../docs/architecture/data-model.md)) so the
notification is visible later via the feed API regardless of whether the
recipient was connected at send time. Also backs
`GET /v1/feed/:recipientId` and the read/unread endpoints (routed through
`services/api`, reading the same Cassandra-backed
`NotificationFeedItem` projection this service writes).

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`RateLimiter`, `InAppGateway`.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-phased-channel-rollout.md)).
