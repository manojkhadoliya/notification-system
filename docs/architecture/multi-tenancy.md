# Multi-Tenancy, Idempotency, and Rate Limiting

## Tenancy model

Every entity in every bounded context is scoped by `tenantId` (owned by the
Identity & Tenancy context, referenced by id from the others — see
[`domain-model.md`](domain-model.md)). A single shared Postgres database
(identity, preferences, templates) and a single Kafka cluster + Cassandra
cluster (notification delivery) serve all tenants — pooled/shared
infrastructure, not one stack per tenant. This is deliberate, not just a
Phase 1 simplification: the pooled model is what lets user-count growth
(illustratively, ~100 users to ~1,000,000 over 3-4 years — see
[`scaling-strategy.md`](scaling-strategy.md)) be absorbed by adding capacity
to the shared infrastructure rather than provisioning new infrastructure
per tenant. Per-tenant isolation, if ever needed (e.g. for a compliance
requirement), remains an infra-layer change behind the same ports — not a
domain rewrite.

Notification-topic partitioning uses `recipientId`, not `tenantId` — see
[`scaling-strategy.md`](scaling-strategy.md#why-the-kafka-partition-key-is-recipientid-not-tenantid)
for why a tenant-keyed partition would cap a single large tenant's
throughput regardless of total partition count.

## Auth

- Requests authenticate with `Authorization: Bearer <api-key>`.
- `ApiKey.hashed_key` is checked (never store or log the raw key); a valid
  key resolves to a `tenantId` used to scope every downstream repository
  call.
- Revoked keys (`revoked_at` set) are rejected immediately.

## Idempotency

- Clients must send an `Idempotency-Key` header on `POST /v1/notifications`.
- Before writing a `NotificationRequest`, the API checks the
  `IdempotencyStore` port (implemented by `infra-redis`) for
  `(tenantId, idempotencyKey)`.
  - Not seen before → proceed, then record the key (with a TTL, e.g. 24h).
  - Seen before with an identical payload → return the original 202
    response (safe retry).
  - Seen before with a different payload → 409 Conflict.
- This protects against duplicate sends from client-side retries, which
  matter more for notifications than most APIs (a duplicated SMS is a bad
  user experience and, for SMS/push providers, a real cost).

## Rate limiting

- Token-bucket algorithm per `(tenantId, channel)`, implemented via the
  `RateLimiter` port (`infra-redis`), enforced in the workers immediately
  before calling a channel gateway (not just at API ingest), so a burst
  that clears ingest but overwhelms a provider is still capped.
- Limits are defined per tenant as a `RateLimitPolicy` (Identity & Tenancy
  context) — allows differentiated limits per tenant later (e.g. paid vs
  free demo tenants) without changing the enforcement mechanism.
- Exceeding the limit at ingest returns `429`; exceeding it at dispatch
  time re-queues the message with backoff rather than dropping it.
- **Known scaling edge case:** a `(tenantId, channel)` token-bucket key is a
  single Redis key, so an extremely high-volume tenant concentrates its
  rate-limit checks on one Redis Cluster shard. Not a problem at the growth
  curve this system is designed against (see
  [`scaling-strategy.md`](scaling-strategy.md)); flagged there as an
  identified, not-yet-built mitigation (sharded sub-buckets) rather than
  silently assumed away.

## Why this matters for the portfolio goal

Multi-tenancy, idempotency, and rate limiting are the parts of a
notification system that are easy to skip in a toy version but are exactly
what makes a real one hard — they're included from Phase 1 specifically to
demonstrate that judgment, applied uniformly across all four channels
(see [ADR 0004](../adr/0004-phased-channel-rollout.md)) rather than
gold-plating features not yet needed.
