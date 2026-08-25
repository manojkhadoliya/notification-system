# services/api

Fastify HTTP API — the entry point for notification requests and
preference management. A **composition root**: contains no business logic
itself, just route handlers that call into `domain-notification`,
`domain-preferences`, and `domain-identity`, wired to concrete adapters
(`infra-postgres`, `infra-kafka`, `infra-redis`) at startup via dependency
injection. Produces accepted notification requests directly to Kafka — no
outbox table, no relay process (see
[ADR 0008](../../docs/adr/0008-elastic-scale-data-plane.md)).

**Depends on (ports):** `NotificationRepository` (read-only — status
queries), `PreferenceRepository`, `ApiKeyRepository`, `MessageBroker`,
`IdempotencyStore`, `RateLimiter`. `POST /v1/notifications` only ever
writes through `MessageBroker`; `NotificationRepository` is used solely by
`GET /v1/notifications/:id`, reading the `infra-cassandra` projection.

**Endpoints:** see [`../../docs/architecture/api-spec.md`](../../docs/architecture/api-spec.md).

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
Rationale for running as a long-lived Fastify process (not
API-Gateway/Lambda, not Express) in
[ADR 0007](../../docs/adr/0007-http-framework-fastify.md).
