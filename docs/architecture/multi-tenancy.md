# Multi-Tenancy, Idempotency, and Rate Limiting

## Tenancy model

Every entity in every bounded context is scoped by `tenantId` (owned by the
Identity & Tenancy context, referenced by id from the others — see
[`domain-model.md`](domain-model.md)). A single shared Postgres database
(identity, preferences) and a single Kafka cluster + Cassandra cluster
(notification delivery) serve all tenants in Phase 1 (pooled/shared
infrastructure, not one stack per tenant) — appropriate for a portfolio
demo; the ports/adapters boundary means a move to per-tenant isolation
later is an infra-layer change, not a domain rewrite. `tenantId` is also the
Kafka partition key for notification topics (see
[`messaging.md`](messaging.md)), so per-tenant throughput isolation and the
elastic scale-out story from [ADR 0008](../adr/0008-elastic-scale-data-plane.md)
share the same key, not two separate mechanisms.

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

## Why this matters for the portfolio goal

Multi-tenancy, idempotency, and rate limiting are the parts of a
notification system that are easy to skip in a toy version but are exactly
what makes a real one hard — they're included from Phase 1 specifically to
demonstrate that judgment, scoped to the two Phase 1 channels rather than
gold-plating features not yet needed.
