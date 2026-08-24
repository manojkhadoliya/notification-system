# packages/infra-postgres

Implements the repository ports defined by `domain-notification`,
`domain-preferences`, and `domain-identity` (`NotificationRepository`,
`PreferenceRepository`, `TenantRepository`, `ApiKeyRepository`, ...) using
Prisma against PostgreSQL. Owns the Prisma schema, modeled per bounded
context (see [`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md)),
and the transactional outbox write path used by `apps/api`.

Depends on the `domain-*` packages (to implement their port interfaces);
never the reverse.

**Delivered in:** Phase 1. Rationale for Postgres in
[ADR 0003](../../docs/adr/0003-database-postgres.md); local-vs-hosted plan
in [`../../docs/architecture/infra-strategy.md`](../../docs/architecture/infra-strategy.md).
