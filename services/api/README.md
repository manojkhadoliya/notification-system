# services/api

Fastify HTTP API — the entry point for notification requests, preference
management, template management, and the in-app feed. A **composition
root**: contains no business logic itself, just route handlers that call
into `domain-notification`, `domain-preferences`, `domain-identity`, and
`domain-templates`, wired to concrete adapters (`infra-postgres`,
`infra-kafka`, `infra-cassandra`, `infra-redis`) at startup via dependency
injection. Produces accepted notification requests directly to Kafka — no
outbox table, no relay process (see
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md)).

**Depends on (ports):** `NotificationRepository` (read-only — status
queries and the in-app feed), `PreferenceRepository`, `ApiKeyRepository`,
`TemplateRepository`, `MessageBroker`, `IdempotencyStore`, `RateLimiter`.
`POST /v1/notifications` only ever writes through `MessageBroker`;
`NotificationRepository` is used solely for reads (`GET
/v1/notifications/:id`, `GET /v1/feed/:recipientId`), reading the
`infra-cassandra` projections.

**Endpoints:** see [`../../docs/architecture/api-spec.md`](../../docs/architecture/api-spec.md).

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
Rationale for running as a long-lived Fastify process (not
API-Gateway/Lambda, not Express) in
[ADR 0007](../../docs/adr/0007-http-framework-fastify.md).
