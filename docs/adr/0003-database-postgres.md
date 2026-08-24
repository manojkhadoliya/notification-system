# ADR 0003: PostgreSQL as the primary datastore

## Status
Accepted

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
