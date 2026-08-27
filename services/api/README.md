# services/api

Fastify HTTP API — Door 1 of the two-door ingress (see
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#two-doors-onto-one-backbone)):
the tenant-facing entry point for notification intents, preference
management, template management, and the in-app feed. A **composition
root**: contains no business logic itself, just route handlers that call
into `domain-notification`, `domain-preferences`, `domain-identity`, and
`domain-templates`, wired to concrete adapters (`infra-postgres`,
`infra-kafka`, `infra-redis`) at startup via dependency injection.
Normalizes each intent onto the shared event shape and produces to the
event backbone (`events.*`) — no outbox table, no relay process (see
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md)). It does
not decide the channel, quiet hours, or render the template — that's
`services/router`'s job (see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md)).

**Depends on (ports):** `NotificationRepository` (read-only — status
queries and the in-app feed), `PreferenceRepository`, `ApiKeyRepository`,
`TemplateRepository`, `MessageBroker`, `IdempotencyStore`, `RateLimiter`.
`POST /v1/notifications` only ever writes through `MessageBroker`;
`NotificationRepository` is used solely for reads (`GET
/v1/notifications/:id`, `GET /v1/feed/:recipientId`), reading the
`infra-postgres` projections (Phase 1; Cassandra at a measured threshold —
see [`../../docs/architecture/scaling-strategy.md`](../../docs/architecture/scaling-strategy.md#storage-phasing)).

**Endpoints:** see [`../../docs/architecture/api-spec.md`](../../docs/architecture/api-spec.md).

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
Rationale for running as a long-lived Fastify process (not
API-Gateway/Lambda, not Express) in
[ADR 0007](../../docs/adr/0007-http-framework-fastify.md).
