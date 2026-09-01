# packages/infra-postgres

Implements the repository ports defined by `domain-identity`
(`TenantRepository`, `ApiKeyRepository`), `domain-preferences`
(`PreferenceRepository` — `RecipientKeyRepository` still deferred, see
[`data-privacy.md`](../../docs/architecture/data-privacy.md)), and
`domain-templates` (`TemplateRepository`) using Prisma against PostgreSQL.
Owns the Prisma schema (`prisma/schema.prisma`), modeled per bounded
context (see
[`../../docs/architecture/data-model.md`](../../docs/architecture/data-model.md))
— one section of the schema file per context, in the same order as that
doc, with a `@map`/`@@map` on every field/table so the actual Postgres
column/table names match it exactly.

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

Two adapters worth knowing about before touching them:
- **`PostgresDedupeRepository.tryClaim`** relies on the `DedupeClaim`
  table's composite primary key to make a conflicting claim fail — it's a
  plain `create()` that turns a unique-constraint violation into `false`,
  not a check-then-insert (which would race). See ADR 0010.
- **`PostgresScheduledNotificationRepository.claimDue`** is raw SQL
  (`$queryRaw`, parameterized via `Prisma.sql`) inside a transaction —
  `SELECT ... FOR UPDATE SKIP LOCKED` has no equivalent in Prisma's query
  builder. See ADR 0011#poller-sharding.

- **`PostgresNotificationFeedRepository.save`** is an upsert keyed by
  `notificationRequestId` — `services/worker-inapp` calls it on every
  dispatch attempt, not just the first, so a redelivered
  `command.in_app` message must write the same logical row again, not a
  duplicate. Added alongside `services/worker-inapp` (it's the only
  writer) — see `NotificationFeedRepository`'s doc comment.

Depends on the `shared-kernel`/`domain-identity`/`domain-preferences`/
`domain-templates`/`domain-notification` packages (to implement their port
interfaces); never the reverse.

## Local setup

```
pnpm compose:up                                                   # starts postgres (+ redis, kafka, jaeger)
pnpm --filter @notification-system/infra-postgres prisma:migrate  # creates the schema
pnpm --filter @notification-system/infra-postgres build           # compiles the adapters
pnpm --filter @notification-system/infra-postgres smoke-test      # round-trips a row through every adapter
```

`pnpm install` runs `prisma generate` automatically (a `postinstall`
script on this package) so the generated client's types exist for
`pnpm build` even on a fresh clone, before a database is ever reachable —
`prisma generate` only reads `schema.prisma`, it doesn't connect.
`prisma:validate`/`prisma:migrate` do need `DATABASE_URL` (see
`.env.example`) and, for `migrate`, an actual reachable Postgres.

**Not yet verified against a live database** — the repository adapters
above were built and typechecked without Docker available in that
session; `prisma validate`/`prisma generate` both passed (schema
correctness), but no adapter has actually round-tripped a row through a
real Postgres yet. [`scripts/smoke-test.mjs`](scripts/smoke-test.mjs)
exists specifically to close that gap — it exercises all seven
repositories against a real database (create, read back, assert), including
the two adapters most likely to have a real bug: `DedupeRepository`'s
unique-constraint-violation handling and
`ScheduledNotificationRepository`'s raw `FOR UPDATE SKIP LOCKED` query.
Run it (see "Local setup" below) before trusting this package beyond
"it typechecks."

**Delivered in:** Phase 1. Rationale for Postgres in
[ADR 0003](../../docs/adr/0003-polyglot-persistence.md); local-vs-hosted plan
in [`../../docs/architecture/infra-strategy.md`](../../docs/architecture/infra-strategy.md).
