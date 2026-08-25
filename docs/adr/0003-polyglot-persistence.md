# ADR 0003: Polyglot persistence — PostgreSQL + Cassandra, chosen per bounded context

## Status
In Progress

## Context
Each bounded context persists data with a different shape and access
pattern. `domain-identity` (tenants, API keys) and `domain-preferences`
(recipients, opt-in/quiet-hours) and `domain-templates` (templates,
versions) are structured, relatively low-volume, and provisioning-rate —
writes happen when a tenant is set up or a preference changes, not on every
notification. `domain-notification` (requests, delivery attempts) is the
opposite: write-heavy, always accessed by id, never joined across contexts
(the context map already forbids that), and it's the one context whose
volume scales directly with notification traffic — the same growth curve
[`scaling-strategy.md`](../architecture/scaling-strategy.md) is built
around.

## Decision
Two stores, chosen per context, each behind that context's own repository
port ([ADR 0005](0005-ddd-hexagonal-architecture.md)):

- **PostgreSQL** (`infra-postgres`, via Prisma) for `domain-identity`,
  `domain-preferences`, and `domain-templates`.
- **Cassandra or ScyllaDB** (`infra-cassandra` — the two are wire-compatible,
  either works) for `domain-notification`'s `NotificationRepository`,
  populated as a read-model projection off the Kafka event stream (CQRS —
  see [ADR 0008](0008-notification-delivery-cqrs.md) for the pattern).

Nothing requires every context to share one database technology — each
context's persistence choice is local to that context's own access
pattern, not a system-wide default.

## Rationale
- **PostgreSQL fits the relational, lower-volume contexts.** Clear entity
  relationships (`Tenant` → `ApiKey`, `Recipient` → `Preference`, `Template`
  → `TemplateVersion`), transactional guarantees where they matter (e.g. key
  revocation), and `jsonb` covers the one loosely-structured piece
  (notification payloads, which live in the *other* context anyway).
- **Cassandra fits `domain-notification`'s hot path.** Write-heavy,
  always-by-id, never-joined access is exactly what a wide-column store is
  built for, and it scales by adding nodes — a capacity change, not a
  redesign. The hottest reads *against the Postgres-backed contexts*
  (API-key validation per request, preference checks per dispatch) are
  read-through cached in Redis by the `infra-postgres` adapters
  (implementation detail behind the existing ports, not a port change) plus
  connection pooling — this is what keeps a single Postgres instance
  sufficient through the full growth curve, since Postgres only ever sees
  provisioning-rate writes, not dispatch-rate reads. Full detail:
  [`scaling-strategy.md`](../architecture/scaling-strategy.md#keeping-postgres-off-the-hot-path).

## Alternatives considered
- **MongoDB, system-wide**: schema flexibility that this system mostly
  doesn't need — the one loosely-structured field (notification payload)
  is already covered by Postgres's `jsonb` in the contexts that use
  Postgres, and by Cassandra's native flexibility on the hot path.
  Rejected for trading away consistency guarantees the
  identity/preferences/templates contexts benefit from, for flexibility
  that isn't the actual constraint anywhere in this system.
- **Distributed SQL (CockroachDB/Citus) for the notification-delivery hot
  path**, instead of a wide-column store: keeps ACID transactions and SQL,
  a smaller conceptual jump from Postgres. Rejected for that specific
  context because `NotificationRequest`/`DeliveryAttempt`'s access
  pattern — write once, read by id, no joins — doesn't need transactional
  guarantees across rows, and the coordination cost distributed SQL pays
  to offer them anyway is exactly the overhead a wide-column store skips.
  Not a system-wide verdict against distributed SQL — a future context
  with a real cross-row transactional need at scale would be a legitimate
  place to reach for it.

## Consequences
- Each Postgres-backed context's tables are modeled as a separable Prisma
  schema module, sharing one physical Postgres instance — keeps a future
  split into per-context databases low-effort (see
  [`data-model.md`](../architecture/data-model.md)).
- Cross-context queries by join are disallowed by convention — a context
  only queries its own tables, referencing others by id.
- `NotificationRepository` reads are eventually consistent with the Kafka
  event stream, not transactional — a `GET` immediately after acceptance
  may briefly not reflect it yet. Mitigated with `QUORUM` read/write
  consistency and idempotent projection consumers, not eliminated. See
  [ADR 0008](0008-notification-delivery-cqrs.md).
- Retention/TTL policy for the Cassandra-backed tables isn't sized yet —
  flagged in [`data-model.md`](../architecture/data-model.md#notes) rather
  than silently left unbounded.
