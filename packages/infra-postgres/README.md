# packages/infra-postgres

Implements the repository ports defined by `domain-identity`,
`domain-preferences` (including, once built, `RecipientKeyRepository` —
see [`data-privacy.md`](../../docs/architecture/data-privacy.md)), and
`domain-templates` (`TenantRepository`, `ApiKeyRepository`,
`PreferenceRepository`, `TemplateRepository`) using Prisma against
PostgreSQL. Owns the Prisma schema, modeled per bounded context (see
[`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md)).

**Also implements `domain-notification`'s `NotificationRepository`,
`DedupeRepository`, and `ScheduledNotificationRepository` for Phase 1** —
revised from the original decision, per
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md) (revised): the
honest capacity estimate doesn't justify Cassandra on day one, so
notification-delivery's read model, dedupe claims, and scheduled
deferrals all live here too until a stated write-volume threshold is
crossed (see
[`scaling-strategy.md`](../../docs/architecture/scaling-strategy.md#storage-phasing)),
at which point `infra-cassandra` takes over those first two ports behind
the same interfaces.

Depends on the `domain-identity`/`domain-preferences`/`domain-templates`/
`domain-notification` packages (to implement their port interfaces); never
the reverse.

**Delivered in:** Phase 1. Rationale for Postgres in
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md); local-vs-hosted plan
in [`../../docs/architecture/infra-strategy.md`](../../docs/architecture/infra-strategy.md).
