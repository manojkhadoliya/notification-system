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
  `domain-preferences`, `domain-templates`, and — **revised, see
  "Phasing" below** — `domain-notification`'s read-model ports
  (`NotificationRepository`, `DedupeRepository`,
  `ScheduledNotificationRepository`) for Phase 1.
- **Cassandra or ScyllaDB** (`infra-cassandra` — the two are wire-compatible,
  either works) as the eventual backing for those same
  `domain-notification` ports, once a stated write-volume threshold is
  crossed. Not built in Phase 1; the port is defined now so the move is an
  adapter swap.

Nothing requires every context to share one database technology — each
context's persistence choice is local to that context's own access
pattern, not a system-wide default.

### Phasing (revised from the original decision)

The original version of this ADR put `domain-notification` on Cassandra
from day one. Revised: **Postgres for Phase 1**, Cassandra at a measured
threshold. The original capacity estimate — 1M users, "50-80M
notifications/day" — implies 26-80 sends per user per day; realistic
consumer platforms run 1-5/day, putting the honest figure closer to
1-5M/day (~12-60/sec average), not the ~600-900/sec the original number
implies. At the honest number, a single Postgres instance handles
`domain-notification`'s write-heavy tables without strain, and this
context's CQRS/dispatch logic (see
[ADR 0008](0008-notification-delivery-cqrs.md),
[ADR 0009](0009-event-backbone-router.md),
[ADR 0010](0010-delivery-reliability.md)) is easier to build and debug
against one transactional store before introducing Cassandra's
eventual-consistency behavior. See
[`scaling-strategy.md`](../architecture/scaling-strategy.md#storage-phasing)
for the exact per-table thresholds and what each moves to. This doesn't
reverse the rationale below for *why* Cassandra fits this context's access
pattern at real volume — it only changes *when* that store is introduced.

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
  split into per-context databases (and, for `domain-notification`, a
  future move to Cassandra) low-effort (see
  [`data-model.md`](../architecture/data-model.md)).
- Cross-context queries by join are disallowed by convention — a context
  only queries its own tables, referencing others by id.
- `NotificationRepository` reads are eventually consistent with the Kafka
  event stream, not transactional — a `GET` immediately after acceptance
  may briefly not reflect it yet. This is unchanged by the Phase 1/Postgres
  revision above: it's a property of the CQRS pattern
  ([ADR 0008](0008-notification-delivery-cqrs.md)), not of which store
  backs the read side. Mitigated with idempotent, ordered-state-machine
  projection consumers (see
  [ADR 0010](0010-delivery-reliability.md#single-writer-status)), not
  eliminated.
- Retention/TTL policy for `domain-notification`'s read-model tables isn't
  sized yet — flagged in
  [`data-model.md`](../architecture/data-model.md#notes) rather than
  silently left unbounded.
- Nothing on the delivery path reads through `NotificationRepository` —
  workers and the router don't depend on this projection being caught up.
  See [ADR 0009](0009-event-backbone-router.md).
