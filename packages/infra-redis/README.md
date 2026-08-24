# packages/infra-redis

Implements the `RateLimiter` (token bucket, per tenant/channel) and
`IdempotencyStore` ports, using Redis. Used by `apps/api` (idempotency
check + ingest-time rate limiting) and by `apps/worker-sms`/
`apps/worker-push` (dispatch-time rate limiting).

Depends on `domain-identity` (`RateLimiter` port) and `domain-notification`
(`IdempotencyStore` port); never the reverse.

**Delivered in:** Phase 1. See
[`../../docs/architecture/multi-tenancy.md`](../../docs/architecture/multi-tenancy.md)
for the idempotency and rate-limiting design.
