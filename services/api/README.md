# services/api

Fastify HTTP API — Door 1 of the two-door ingress (see
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#two-doors-onto-one-backbone)):
the tenant-facing entry point for notification intents, preference
management, and template management. A **composition root**: contains no
business logic itself, just route handlers that call into
`domain-notification`, `domain-preferences`, `domain-identity`, and
`domain-templates`, wired to concrete adapters (`infra-postgres`,
`infra-kafka`, `infra-redis`) at startup via dependency injection.
Normalizes each intent onto the shared event shape and produces to the
event backbone (`events.*`) — no outbox table, no relay process (see
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md)). It does
not decide the channel, quiet hours, or render the template — that's
`services/router`'s job (see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md)).

## What's built

`POST/GET /v1/notifications`, `GET/PUT /v1/preferences/:recipientId`,
`POST /v1/templates`, `POST /v1/templates/:id/versions`,
`GET /v1/templates/:id` — see
[`../../docs/architecture/api-spec.md`](../../docs/architecture/api-spec.md)
for the full contract. Every route requires
`Authorization: Bearer <api-key>` (SHA-256-hashed, looked up via
`ApiKeyRepository.findByHashedKey` — see `hash-api-key.ts`'s doc comment
for why not bcrypt/argon2).

**Deliberately deferred, not built here:**
- `GET /v1/feed/:recipientId` / `POST /v1/feed/:recipientId/:id/read` —
  `NotificationFeedItem` isn't modeled anywhere yet (no domain port, no
  Postgres table); `infra-postgres/README.md` already documents this as
  "add both together when `services/worker-inapp` is built." Adding
  half of that pairing here, ahead of the other half, isn't worth doing.
- `POST /v1/webhooks/twilio` — needs a way to correlate a Twilio
  `MessageSid` back to `(notificationRequestId, attemptNumber)`, which no
  port currently exposes (`DeliveryAttempt.providerResponse` stores it,
  but nothing can query *by* it yet). `providers-sms` already has
  `verifyTwilioSignature` ready for whoever builds this next.

## Real gaps surfaced and fixed while building this

- `domain-preferences`'s `PreferenceRepository` had `findPreferences`
  (scoped to one `notificationType`, for the router) but no way to fetch
  *every* preference for a recipient — what `GET /v1/preferences/:id`
  actually needs. Added `findAllPreferences` to the port and its
  `infra-postgres` adapter.
- `domain-templates`'s `TemplateRepository` had `findVersion` (one, by
  id) and `findLatestVersion` (one, per locale) but no way to fetch a
  template's full version history — what `GET /v1/templates/:id` ("its
  version history") actually needs. Added `findVersionHistory`.

## Judgment calls worth knowing about

- **`priority` on Door 1 requests.** `api-spec.md`'s `POST /v1/notifications`
  body has no `priority` field. Every request defaults to `"standard"`
  until the spec grows one.
- **Ingest-time rate limiting only applies when the caller supplies an
  explicit `channel` override.** `RateLimiter.tryConsume` is keyed by
  `(tenantId, channel)`, but Door 1's channel is usually unresolved until
  `services/router` runs. An unrouted request is instead capped at
  dispatch time once a channel exists — the same enforcement point every
  request eventually passes through, per
  [`multi-tenancy.md`](../../docs/architecture/multi-tenancy.md#rate-limiting).
- **A duplicate `Idempotency-Key` request is answered straight from the
  `IdempotencyRecord`**, not a `NotificationRepository` lookup — the
  `202` body (`{id, status: "accepted"}`) doesn't need anything the
  record doesn't already have, and the read-model row for that id may
  not exist yet regardless (see the next point).
- **`POST /v1/notifications` never touches `NotificationRepository`.**
  It mints the `notificationRequestId` and publishes the event;
  `services/projection-notification` (not yet built) is what will
  actually create the read-model row, consuming that same event. One
  consequence worth flagging for whoever builds that service:
  `NotificationRequest.accept()` currently requires a non-null
  `channel`, but the event this endpoint publishes can have a `null`
  one (unresolved until routing) — reconciling that is
  `projection-notification`'s design problem, not guessed at here.
- **`PUT /v1/preferences/:recipientId` implicitly creates the
  `Recipient`** if one doesn't exist — `api-spec.md` has no
  recipient-creation endpoint, so this is the first place a
  `recipientId` can legitimately be referenced without prior setup.
- **Cross-tenant reads return `404`, not `403`** — a response never
  confirms that a resource belonging to a different tenant exists.

## Testing

`server.ts`'s `buildServer(deps)` takes already-constructed ports, which
is what makes it unit-testable: every `routes/*.test.ts` file drives real
HTTP requests through `app.inject()` against the in-memory fakes in
`test-support.ts` (same "test against fakes behind the real port"
approach `DispatchService`'s own suite uses) — no live Postgres/Kafka/
Redis needed for any of it. 39 tests: auth, idempotency (including a
same-key/same-body replay and a same-key/different-body conflict),
ingest-time rate-limit gating, tenant isolation on every read/write, and
the template-versioning/quiet-hours-formatting logic.

**Not yet verified against live infra** — no Docker in the session this
was built in. `scripts/smoke-test.mjs` seeds its own `Tenant`/`ApiKey`
directly via Prisma (there's no self-service signup endpoint) and then
drives the real HTTP surface end to end; see that script's header comment
for the run steps.

**Depends on (ports):** `NotificationRepository` (read-only — status
queries; `GET /v1/feed/:recipientId` is deferred, see above),
`PreferenceRepository`, `ApiKeyRepository`, `TemplateRepository`,
`MessageBroker`, `IdempotencyStore`, `RateLimiter`. `POST /v1/notifications`
only ever writes through `MessageBroker`; `NotificationRepository` is used
solely for reads (`GET /v1/notifications/:id`), reading the
`infra-postgres` projection (Phase 1; Cassandra at a measured threshold —
see [`../../docs/architecture/scaling-strategy.md`](../../docs/architecture/scaling-strategy.md#storage-phasing)).

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/api build
pnpm --filter @notification-system/api start     # reads .env — see .env.example
pnpm --filter @notification-system/api smoke-test
```

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
Rationale for running as a long-lived Fastify process (not
API-Gateway/Lambda, not Express) in
[ADR 0007](../../docs/adr/0007-http-framework-fastify.md).
