# ADR 0003: PostgreSQL as the primary datastore

## Status
Accepted. Partially superseded by [ADR 0008](0008-elastic-scale-data-plane.md):
`domain-notification`'s hot-path store moved to a wide-column store for
elastic peak scale, and the transactional-outbox rationale below no longer
applies to that context. This ADR's decision and rationale remain in force
for `domain-identity`, `domain-preferences`, and `domain-templates`, which
keep Postgres — see
[`scaling-strategy.md`](../architecture/scaling-strategy.md#keeping-postgres-off-the-hot-path)
for how these contexts stay on a single Postgres instance through the
system's full user-growth curve.

## Context
Every bounded context needs to persist structured, relational data
(tenants, recipients, preferences, requests, delivery attempts) with strong
consistency requirements — in particular, the transactional outbox pattern
(see [`messaging.md`](../architecture/messaging.md)) requires writing a
domain row and an outbox row atomically in one transaction.

## Decision
PostgreSQL, accessed only through per-context repository ports
(`NotificationRepository`, `PreferenceRepository`, etc.) implemented in
`infra-postgres` via Prisma.

## Rationale
- Structured, relational data with clear entity relationships fits
  PostgreSQL's model well; the alternative considered (MongoDB) trades away
  transactional guarantees the outbox pattern depends on, for schema
  flexibility this system doesn't need (notification payloads are the one
  loosely-structured piece, and `jsonb` covers that inside Postgres).
- Genuine free tiers exist for hosted Postgres (Supabase, Neon) that are
  wire-compatible with self-hosted Postgres, fitting the local-first /
  free-tier infra constraint.

## Consequences
- Each bounded context's tables are modeled as a separable Prisma schema
  module even while sharing one physical database in Phase 1, keeping a
  future split into per-context databases low-effort (see
  [`data-model.md`](../architecture/data-model.md)).
- Cross-context queries by join are disallowed by convention — a context
  only queries its own tables, referencing others by id.
- The hottest reads against these contexts — API-key validation on every
  request, preference checks on every dispatch — are read-through cached in
  Redis by the `infra-postgres` adapters (implementation detail behind the
  existing `ApiKeyRepository`/`PreferenceRepository` ports, not a port
  change), plus connection pooling (PgBouncer). This is what keeps a single
  Postgres instance sufficient for these contexts across the full
  user-growth curve in
  [`scaling-strategy.md`](../architecture/scaling-strategy.md) — Postgres
  only ever sees provisioning-rate writes, not dispatch-rate reads.
