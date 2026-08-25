# packages/infra-postgres

Implements the repository ports defined by `domain-identity`,
`domain-preferences`, and `domain-templates` (`TenantRepository`,
`ApiKeyRepository`, `PreferenceRepository`, `TemplateRepository`) using
Prisma against PostgreSQL. Owns the Prisma schema, modeled per bounded
context (see
[`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md)).

Does **not** implement `NotificationRepository` — `domain-notification`'s
read model is backed by `infra-cassandra` instead, per
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md): these three
contexts' write volume stays well below the notification-send hot path, so
they're on Postgres while notification-delivery isn't.

Depends on the `domain-identity`/`domain-preferences`/`domain-templates`
packages (to implement their port interfaces); never the reverse.

**Delivered in:** Phase 1. Rationale for Postgres in
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md); local-vs-hosted plan
in [`../../docs/architecture/infra-strategy.md`](../../docs/architecture/infra-strategy.md).
