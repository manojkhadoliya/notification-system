# services/worker-inapp

Consumes `command.in_app` and its retry tiers
(`command.in_app.retry-30s/-5m/-30m`). A **composition root**, narrower
than `worker-sms`/`worker-push`/`worker-email` since
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md): `in_app` has no
external provider, so instead of calling one, `WorkerService` (structurally
identical to the other three workers) dispatches through
`FeedWritingInAppGateway` — an `InAppGateway` implementation local to this
package that writes a `NotificationFeedItem` row, *then* delegates to
`infra-redis`'s `RedisInAppGateway` for the Redis pub/sub nudge to a live
socket (`services/inapp-gateway`, not yet built, is what would be
listening). This worker never holds any WebSocket connection state itself
— see that ADR for why the split.

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`NotificationFeedRepository`, `NotificationRepository` (write-only here —
`saveAttempt`).

## Real gaps surfaced and fixed while building this

- `domain-notification` had no `NotificationFeedItem` entity or
  `NotificationFeedRepository` port at all — `infra-postgres/README.md`
  already flagged this as deliberately deferred, "add both together when
  `services/worker-inapp` is built." Added both, plus the
  `notification_feed_items` Postgres table and
  `PostgresNotificationFeedRepository` (an upsert-by-`notificationRequestId`
  adapter — see the port's doc comment for why an upsert, not a plain
  insert). `services/api`'s `GET /v1/feed/:recipientId` and mark-read
  endpoints were deferred pending exactly this — they're still not wired
  up here (that's `services/api`'s job, in a future PR), but the port and
  adapter they'll need now exist.

## Why a composed gateway, not a DispatchService change

`DispatchService`'s dedupe-claim → rate-limit → send → DLQ/retry sequence
is channel-agnostic and already fully built and tested — reusing it
unchanged (rather than special-casing `in_app` inside it) means this
worker gets the exact same dedupe/retry/rate-limit guarantees every other
channel gets, for free. The only thing `in_app` needs that a fire-and-forget
external-provider `send()` doesn't is "write the feed row first" — so
that's a `send()` implementation of its own (`FeedWritingInAppGateway`),
not a change to the orchestration around it. The feed write is idempotent
(safe to repeat on a redelivered attempt — including a retry of *this*
worker's own `send()` call if the pub/sub half failed after the feed
write succeeded), so `DispatchService`'s normal retry path works
correctly here without any special handling.

## Testing

`feed-writing-gateway.test.ts` covers `FeedWritingInAppGateway` directly:
write-then-publish ordering, a malformed payload (not retryable), a feed
write failure (retryable, pub/sub never reached), a pub/sub publish with
no live subscriber still succeeding, and upsert-not-duplicate behavior on
a redelivered attempt. `worker-service.test.ts` exercises `WorkerService`
against a real `DispatchService` wired to in-memory fakes, same as the
other three workers.

**Not yet verified against live Postgres/Kafka/Redis** — no Docker in
the session this was built in. `scripts/smoke-test.mjs` publishes a
`ChannelCommand` directly onto `command.in_app`, asserts a
`delivery-status` `sent` event arrives, and asserts a feed-item message
arrives on `infra-redis`'s pub/sub channel; see that script's header
comment for the run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/worker-inapp build
pnpm --filter @notification-system/worker-inapp start     # reads .env — see .env.example
pnpm --filter @notification-system/worker-inapp smoke-test
```

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-channel-rollout.md)).
