# packages/infra-redis

Implements the `RateLimiter` (token bucket, per tenant/channel) and
`IdempotencyStore` ports, using Redis. Used by `services/api` (idempotency
check + ingest-time rate limiting) and by the channel workers
(dispatch-time rate limiting, immediately before the dedupe claim + gateway
call — see [ADR 0010](../../docs/adr/0010-delivery-reliability.md)).

Also implements a pub/sub port used only by
`services/worker-inapp`/`services/inapp-gateway` (see
[ADR 0012](../../docs/adr/0012-inapp-gateway-split.md)) — `worker-inapp`
publishes after writing a feed row, `inapp-gateway` subscribes and pushes
to a connected recipient's socket. This is unrelated to rate
limiting/idempotency; it's grouped here because both are Redis-backed
infrastructure for `domain-notification`.

Depends on `domain-identity` (`RateLimiter` port) and `domain-notification`
(`IdempotencyStore` port, pub/sub); never the reverse.

**Delivered in:** Phase 1. See
[`../../docs/architecture/multi-tenancy.md`](../../docs/architecture/multi-tenancy.md)
for the idempotency and rate-limiting design.
