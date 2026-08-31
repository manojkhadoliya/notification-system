# packages/infra-redis

Implements the `RateLimiter` (token bucket, per tenant/channel) and
`IdempotencyStore` ports, using Redis ([ioredis](https://github.com/redis/ioredis)).
Used by `services/api` (idempotency check + ingest-time rate limiting) and
by the channel workers (dispatch-time rate limiting, immediately before
the dedupe claim + gateway call — see
[ADR 0010](../../docs/adr/0010-delivery-reliability.md)).

Also implements a pub/sub port used only by
`services/worker-inapp`/`services/inapp-gateway` (see
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md)) — `worker-inapp`
publishes after writing a feed row, `inapp-gateway` subscribes and pushes
to a connected recipient's socket. This is unrelated to rate
limiting/idempotency; it's grouped here because both are Redis-backed
infrastructure for `domain-notification`.

- **`RedisRateLimiter`** — token-bucket algorithm, read-refill-write done
  atomically server-side via a Lua script (`TOKEN_BUCKET_LUA`) so
  concurrent callers hitting the same `(tenantId, channel)` key can't
  race each other into over-admitting. The bucket math itself
  (`stepTokenBucket`) is a pure function with its own unit tests
  (`token-bucket.test.ts`) — the Lua script is a hand-mirrored copy of
  that same logic, since it can't be unit-tested the same way without a
  live Redis. Structurally satisfies both `domain-identity`'s and
  `domain-notification`'s copies of the `RateLimiter` port (see the
  latter's doc comment for why there are two). No `RateLimitPolicy`
  repository exists yet, so policy lookup is a constructor-injected
  `resolvePolicy` function, defaulting to `createDefaultRateLimitPolicy`.
- **`RedisIdempotencyStore`** — implements `domain-notification`'s
  `IdempotencyStore` port (added this pass — the port didn't exist yet
  before this adapter needed it), TTL'd at 24h by default.
- **`RedisInAppGateway`** — implements `domain-notification`'s
  `InAppGateway` port. `send()` publishes to a single global pub/sub
  channel (`INAPP_PUBSUB_CHANNEL`); every `inapp-gateway` replica
  subscribes and filters by `recipientId` locally, since a publish fans
  out to all subscribers and no replica knows in advance which
  recipients' sockets it holds (see ADR 0012). A publish with no live
  subscriber still returns `success: true` — the durable delivery is the
  `NotificationFeedItem` row `worker-inapp` writes before calling this,
  not the pub/sub nudge itself.
- **`InAppSubscriber`** — a thin wrapper for the future
  `services/inapp-gateway` composition root, same role as `infra-kafka`'s
  `KafkaConsumer`: not a domain port, since "subscribe and push to a
  socket" is per-composition-root reaction logic. **Requires a Redis
  connection dedicated to it** (`someClient.duplicate()`) — once an
  ioredis connection issues `SUBSCRIBE` it can't run any other command,
  so it can't share a connection with `RedisRateLimiter`/
  `RedisIdempotencyStore`/`RedisInAppGateway`.

Depends on `domain-identity` (`RateLimiter` port) and `domain-notification`
(`IdempotencyStore` port, `InAppGateway` port); never the reverse.

## Local setup

```
pnpm compose:up                                              # starts redis (+ postgres, kafka, jaeger)
pnpm --filter @notification-system/infra-redis build
pnpm --filter @notification-system/infra-redis smoke-test     # round-trips rate limiter, idempotency store, in-app pub/sub
```

**Not yet verified against a live Redis** — built and typechecked without
Docker available in that session. `smoke-test.mjs` exercises all three
adapters against a real connection: 4 calls against a 3-token bucket
(expects allow/allow/allow/deny), a find→reserve→find idempotency
round trip, and a publish→subscribe in-app notification round trip; run it
before trusting this package beyond "it typechecks and its pure logic is
unit-tested."

**Delivered in:** Phase 1. See
[`../../docs/architecture/multi-tenancy.md`](../../docs/architecture/multi-tenancy.md)
for the idempotency and rate-limiting design.
