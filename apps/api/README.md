# apps/api

Fastify HTTP API — the entry point for notification requests and
preference management. A **composition root**: contains no business logic
itself, just route handlers that call into `domain-notification`,
`domain-preferences`, and `domain-identity`, wired to concrete adapters
(`infra-postgres`, `infra-rabbitmq`, `infra-redis`) at startup via
dependency injection.

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`ApiKeyRepository`, `MessageBroker`, `IdempotencyStore`, `RateLimiter`.

**Endpoints:** see [`../../docs/architecture/api-spec.md`](../../docs/architecture/api-spec.md).

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
