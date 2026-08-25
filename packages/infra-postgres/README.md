# packages/infra-postgres

Implements the repository ports defined by `domain-preferences` and
`domain-identity` (`PreferenceRepository`, `TenantRepository`,
`ApiKeyRepository`) using Prisma against PostgreSQL. Owns the Prisma schema,
modeled per bounded context (see
[`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md)).

Does **not** implement `NotificationRepository` — `domain-notification`'s
hot-path read model is backed by `infra-cassandra` instead, per
[ADR 0008](../../docs/adr/0008-elastic-scale-data-plane.md). This package's
scope narrowed to the two contexts whose write volume stays well below the
notification-send hot path.

Depends on the `domain-identity`/`domain-preferences` packages (to
implement their port interfaces); never the reverse.

**Delivered in:** Phase 1. Rationale for Postgres in
[ADR 0003](../../docs/adr/0003-database-postgres.md); local-vs-hosted plan
in [`../../docs/architecture/infra-strategy.md`](../../docs/architecture/infra-strategy.md).
