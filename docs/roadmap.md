# Roadmap

Living checklist for the build. Architecture details behind each item are in
[`architecture/`](architecture); decisions behind each choice are in
[`adr/`](adr). Per [ADR 0004](adr/0004-channel-rollout.md), all four
channels are built together as one local-only phase — there is no separate
channel-rollout phasing and no committed hosted-deployment phase yet; see
"Future work" at the bottom.

## Phase 0 — Scaffolding
- [x] Monorepo setup (pnpm workspaces, TypeScript project references) —
      every `packages/*`/`services/*` member has a `package.json` +
      `tsconfig.json` wired per its declared dependencies (see each
      package's README's "Depends on"); `pnpm build` (`tsc -b`) succeeds
      across the whole graph
- [x] ESLint / Prettier config (`eslint.config.mjs`, `.prettierrc.json`) —
      `pnpm lint` / `pnpm format` both pass
- [x] Package boundary rule (`dependency-cruiser`, not just a lint rule —
      see [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs))
      forbidding `domain-*` from importing `infra-*` / `providers-*` /
      `observability`. Verified with a deliberate throwaway violation
      (`domain-notification` importing `infra-kafka`) — `pnpm boundaries`
      correctly failed with `error domain-must-not-import-adapters`
      before the violation was reverted
- [x] `docker-compose.yml` skeleton: postgres, redis, kafka only —
      Cassandra deferred, see
      [`architecture/scaling-strategy.md`](architecture/scaling-strategy.md#storage-phasing)
      and [ADR 0003](adr/0003-polyglot-persistence.md). Also adds `jaeger`
      (OTLP trace backend for `packages/observability`, added this pass
      rather than deferred — see
      [`architecture/infra-strategy.md`](architecture/infra-strategy.md)).
      **Not yet run** — no Docker available in the sandbox this was
      authored in; needs a `pnpm compose:up` smoke test on a real machine
- [x] Kafka topic creation matching the actual topology: `events.critical`
      / `.standard` / `.bulk`, `events.broadcast`,
      `events.broadcast.chunks`, `command.{sms|push|email|in_app}` +
      their `.retry-30s`/`.retry-5m`/`.retry-30m`/`.dlq`, `delivery-status`
      — see [`architecture/messaging.md`](architecture/messaging.md#topic-layout)
      and [`../infra/kafka/create-topics.sh`](../infra/kafka/create-topics.sh).
      **Not yet run**, same caveat as above
- [ ] Internal producer library (Door 2) — same normalized event shape as
      Door 1's intent, no HTTP hop — see
      [`architecture/messaging.md`](architecture/messaging.md#two-doors-onto-one-backbone).
      Deliberately **not** scaffolded as its own package: it's a thin
      wrapper around `domain-notification`'s `MessageBroker` port and the
      normalized-event-shape type, both Phase 1 deliverables (see
      `packages/shared-kernel`'s and `packages/domain-notification`'s
      READMEs) — there's nothing for it to wrap yet
- [x] `packages/observability` — shared OpenTelemetry bootstrap
      (`startTracing`), exporting traces via OTLP/HTTP to the `jaeger`
      compose container. Brought forward from the Phase 1
      reliability-polish item below because it's pure infra bootstrap with
      no domain model to wait on; real working code, not a Phase 1 stub —
      see [`packages/observability/README.md`](../packages/observability/README.md)
- [x] CI skeleton: lint + typecheck on push (`.github/workflows/ci.yml`) —
      runs `pnpm format` / `pnpm lint` / `pnpm typecheck` / `pnpm test` /
      `pnpm boundaries` (the `test` step added once Phase 1's domain
      packages had real unit tests to run), all verified locally before
      being wired into the workflow

## Phase 1 — Full local build, all channels
- [x] `domain-notification`: entities (`NotificationRequest`,
      `DeliveryAttempt`, `ScheduledNotification`), value objects
      (`RetryPolicy`, `DedupeClaim`, `RoutingDecision`, `BroadcastRequest`/
      `Chunk`, `ChannelCommand`), ports (`NotificationRepository`,
      `DedupeRepository`, `ScheduledNotificationRepository`,
      `MessageBroker`, `SmsGateway`/`PushGateway`/`EmailGateway`/
      `InAppGateway`, a context-local `RateLimiter` — see its doc comment
      for why it's not imported from `domain-identity`), and the dispatch
      orchestration service (`DispatchService`: dedupe claim → rate limit
      → send → persist). 27 unit tests, including `DispatchService`
      exercised entirely against in-memory fake ports. **Note:** the
      dedupe-claim attempt-scoping question this surfaced is recorded in
      [ADR 0010](adr/0010-delivery-reliability.md), not just a code
      comment — worth a deliberate look, not just inheriting the call made
      here
- [x] `domain-preferences`: `Recipient`/`Preference` entities,
      `PreferenceRepository` port, quiet-hours logic (`isWithinQuietHours`,
      handling the overnight-wraparound case correctly — 13 unit tests).
      `fallback_order` column reserved on `Preference`, not read yet — see
      [`architecture/domain-model.md`](architecture/domain-model.md#recipient-preferences).
      `RecipientKeyRepository` port declared (still deferred — ADR 0013)
- [x] `domain-identity`: `Tenant`/`ApiKey` entities, `RateLimitPolicy`,
      `RateLimiter` port, `TenantRepository`/`ApiKeyRepository` ports
- [x] `domain-templates`: `Template`/`TemplateVersion`/`Locale` entities,
      `TemplateRepository` port. Rendering itself (Handlebars) is
      deliberately not here — see the Handlebars line further down
- [x] `infra-postgres`: Prisma schema + repository adapters for
      `domain-identity`, `domain-preferences`, `domain-templates`, and —
      for Phase 1 — `domain-notification`'s `NotificationRepository` /
      `DedupeRepository` / `ScheduledNotificationRepository` (see
      [ADR 0003](adr/0003-polyglot-persistence.md), revised). Schema
      validated (`prisma validate`/`prisma generate`, no live DB needed for
      either); adapters build and typecheck against the generated client.
      **Not yet run against a live Postgres** — no Docker in the session
      this was built in; see
      [`infra-postgres/README.md`](../packages/infra-postgres/README.md#local-setup)
      for the steps to verify it for real. Building this adapter surfaced
      two real gaps in the Phase 1 domain-layer PR, both fixed here:
      `NotificationRepository` had no way to persist `DeliveryAttempt` rows
      (added `findAttempts`/`saveAttempt`), and `ApiKey` never exposed a
      `createdAt` getter
- [x] `infra-kafka`: `MessageBroker` adapter (`KafkaMessageBroker`,
      kafkajs, idempotent producer), event/command/retry-topic topology
      centralized in `topics.ts` ([ADR 0002](adr/0002-message-broker-kafka.md),
      [ADR 0009](adr/0009-event-backbone-router.md)). Also a generic
      `KafkaConsumer` wrapper for future composition roots to consume
      through. Topic-naming unit tests pass (5); **not yet run against a
      live broker** — see
      [`infra-kafka/README.md`](../packages/infra-kafka/README.md#local-setup)
      for `smoke-test.mjs`, which round-trips a message through every
      topic including the `x-retry-after` header. The retry ladder's
      "hold until the tier elapses" behavior is deliberately **not**
      here — that's timing logic for each channel worker to build using
      this package, not a generic consumer wrapper's job
- [x] `infra-redis`: `RedisRateLimiter` (token bucket, atomic read-refill-
      write via a Lua script; the bucket math itself is a pure function
      with its own unit tests — 6 pass), `RedisIdempotencyStore`, and
      `RedisInAppGateway` + `InAppSubscriber` (pub/sub adapter for
      `worker-inapp` ↔ `inapp-gateway`, see
      [ADR 0012](adr/0012-inapp-gateway-split.md)). **Not yet run against
      a live Redis** — no Docker in the session this was built in; see
      [`infra-redis/README.md`](../packages/infra-redis/README.md#local-setup)
      for `smoke-test.mjs`. Building this adapter surfaced two real gaps,
      both fixed here: `domain-notification` had no `IdempotencyStore`
      port at all (added, alongside `RedisIdempotencyStore`), and no
      `RateLimitPolicy` repository/table exists yet, so `RedisRateLimiter`
      takes a `resolvePolicy` constructor seam defaulting to
      `createDefaultRateLimitPolicy` rather than this adapter inventing
      persistence that isn't scoped yet
- [x] `providers-sms`: `TwilioSmsGateway` (calls Twilio's REST API
      directly over `fetch`, not the `twilio` SDK) + `MockSmsGateway`
      (configurable success rate/latency), selected by the composition
      root's env config. Both interpret `renderedPayload` as `{ to, body
      }` — a contract this package had to define, since
      `ChannelCommand`/`domain-notification` deliberately don't (see
      `providers-sms/README.md`). Also `verifyTwilioSignature` for
      `POST /v1/webhooks/twilio`. 22 unit tests, including
      `TwilioSmsGateway`'s request-building and retryable-status
      classification against a stubbed `fetch` (no live Twilio account
      needed for that) and `verifyTwilioSignature` against
      self-generated fixtures
- [x] `providers-push`: `FcmPushGateway` (calls FCM's HTTP v1 API
      directly over `fetch`; OAuth2 service-account auth hand-built with
      `node:crypto` rather than `google-auth-library`, with in-memory
      access-token caching) + `MockPushGateway` (configurable success
      rate/latency), selected by the composition root's env config. Both
      interpret `renderedPayload` as `{ token, title, body, data? }` — a
      contract this package had to define, since `ChannelCommand`/
      `domain-notification` deliberately don't (see
      `providers-push/README.md`). 26 unit tests, including
      `FcmPushGateway`'s token exchange, token caching/expiry, and error
      classification against a stubbed `fetch`, and the JWT-signing logic
      against a self-generated throwaway keypair (no live Firebase
      project needed for any of it)
- [x] `providers-email`: `MockEmailGateway` only, by explicit decision —
      a real SES/SendGrid adapter is deliberately deferred rather than
      picked without a real need driving the choice (SES needs AWS
      SigV4 signing, a materially bigger lift than Twilio/FCM's schemes;
      SendGrid would match this repo's "no heavy SDK" pattern, so build
      that one first whenever it's actually needed — see
      `providers-email/README.md`). Interprets `renderedPayload` as
      `{ to, subject, body }`, matching `ChannelCommand`'s "subject+body
      shape for email" doc comment. 9 unit tests
- [x] `services/api`: `POST/GET /v1/notifications` (Door 1 — accepts an
      intent, one `recipientId`, optional channel override; no audience
      descriptor — see [`architecture/api-spec.md`](architecture/api-spec.md)),
      `GET/PUT /v1/preferences`, template management endpoints, producing
      to the event backbone (no outbox relay — see ADR 0008). Fastify
      (ADR 0007), Bearer-token auth (SHA-256-hashed key lookup),
      idempotency (`infra-redis`), ingest-time rate limiting. First
      composition root wired with real dependency injection — 39 unit
      tests via `app.inject()` against in-memory port fakes, no live
      infra needed. **Not yet run against live Postgres/Kafka/Redis** —
      no Docker in the session this was built in; see
      [`services/api/README.md`](../services/api/README.md#testing) for
      `smoke-test.mjs`. In-app feed endpoints and the Twilio webhook are
      deliberately deferred (see that README's "What's built" section);
      building this surfaced two real port gaps, both fixed here:
      `PreferenceRepository` had no way to fetch every preference for a
      recipient (added `findAllPreferences`), and `TemplateRepository`
      had no way to fetch a template's full version history (added
      `findVersionHistory`) — both implemented in `infra-postgres` too
- [x] `services/router` (new) — preferences + quiet hours + channel
      resolution + template render, publishes self-contained
      `command.*` plus an `accepted` outcome to `delivery-status` — see
      [ADR 0009](adr/0009-event-backbone-router.md). **The single
      largest structural item in this phase.** Channel decision logic
      (`decideChannel`), template rendering (Handlebars), and per-channel
      payload assembly are pure functions; the composition root
      (`RouterService`) is only I/O sequencing. 32 unit tests, no fakes
      needed for the pure functions, in-memory port fakes for
      `RouterService` itself. **Not yet run against live Postgres/Kafka**
      — no Docker in the session this was built in; see
      [`services/router/README.md`](../services/router/README.md#testing)
      for `smoke-test.mjs`. `domain-preferences` gained
      `nextQuietHoursEnd` (computing a deferred notification's `dueAt`),
      with its own unit tests. Several judgment calls and two
      deliberately-deferred pieces (the `PreferenceRepository` Redis
      read-through cache from `scaling-strategy.md`; template
      auto-resolution by `notificationType`+`channel`) are documented in
      that README rather than guessed at silently — including a real,
      known limitation: quiet hours are enforced in UTC, not a
      recipient's local time, since nothing in the domain model stores
      one yet
- [ ] Dedupe claim (`DedupeRepository`), wired into every `worker-*`
      immediately before the gateway call — see
      [ADR 0010](adr/0010-delivery-reliability.md). The orchestration
      itself (`domain-notification`'s `DispatchService`) is already built
      and tested (above); `infra-postgres`'s `DedupeRepository` adapter
      was already built too. `services/worker-sms`/`worker-push` (below)
      prove the composition-root wiring pattern end to end; `-email`/
      `-inapp` still need it replicated
- [ ] `scheduled_notifications` table + `services/scheduler` (new) —
      poller sharded by `(due_minute, bucket)`, jittered `due_at` from the
      start — see [ADR 0011](adr/0011-scheduling-and-fanout.md)
- [ ] `services/fanout-expander` (new) — audience descriptor → work-sized
      chunks (keyed by `chunkId`) → per-recipient events, Door 2 only —
      see [ADR 0011](adr/0011-scheduling-and-fanout.md)
- [ ] `services/projection-notification`: single writer of
      `NotificationRequest.status`, consuming `events.*` (accepted) +
      `delivery-status` (sent/delivered/failed), ordered state machine —
      see [ADR 0010](adr/0010-delivery-reliability.md#single-writer-status)
- [x] `services/worker-sms`: consumes `command.sms` + all three retry
      tiers (one process, not per tier — see
      [ADR 0010](adr/0010-delivery-reliability.md)). `WorkerService` is
      the thin layer around `DispatchService` (dedupe claim → rate limit
      → send → DLQ/retry-scheduling, already built): tells a main-topic
      message from a retry-tier one, holds the latter until its
      `x-retry-after` elapses then re-publishes onto `command.sms` (not
      a direct dispatch — every attempt goes through the same path), and
      persists a `DeliveryAttempt` for whichever outcomes conclude one.
      A rate-limited outcome re-queues at the same `attemptNumber` via
      the shortest retry tier (30s) — not a `RetryPolicy`-tracked
      attempt, since a rate-limit isn't a provider failure. 15 unit
      tests against a real `DispatchService` wired to in-memory fakes.
      **Not yet run against live Postgres/Kafka/Redis** — no Docker in
      the session this was built in; see
      [`services/worker-sms/README.md`](../services/worker-sms/README.md#testing)
      for `smoke-test.mjs`. Building this surfaced a real gap in
      `infra-kafka`'s `KafkaConsumer`: no way to process assigned
      partitions concurrently, so a long retry-tier wait (up to 30 min)
      would have stalled this worker's own fresh `command.sms` traffic
      behind it — added an optional `partitionsConsumedConcurrently`
      config (defaults to kafkajs's own default, no behavior change for
      existing consumers). **"Circuit breaker" dropped from this item's
      description** — nothing in ADR 0010/messaging.md specifies one
      (only the retry ladder + DLQ), and inventing an undocumented
      per-provider circuit-breaker policy isn't something to improvise
      silently; revisit as a deliberate addition if a real need for one
      shows up
- [x] `services/worker-push`: same shape as `services/worker-sms` above
      (identical `WorkerService`, same retry-ladder/rate-limit-requeue
      logic), against `providers-push` — `PUSH_PROVIDER=fcm` (+
      `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY`) selects the
      real `FcmPushGateway`, defaulting to `MockPushGateway`. 15 unit
      tests. **Not yet run against live Postgres/Kafka/Redis** — see
      [`services/worker-push/README.md`](../services/worker-push/README.md#testing)
      for `smoke-test.mjs`
- [ ] `services/worker-email`: same shape, against `providers-email`
      (mock adapter only, by explicit decision — see
      `providers-email/README.md`)
- [ ] `services/worker-inapp`: consume `command.in_app` + retry tiers,
      dedupe claim, write `NotificationFeedItem`, publish to Redis
      pub/sub — socket holding moved out, see next item
- [ ] `services/inapp-gateway` (new): stateless WebSocket registry,
      subscribes to Redis pub/sub, pushes to connected recipients — see
      [ADR 0012](adr/0012-inapp-gateway-split.md)
- [ ] Template rendering (Handlebars) wired into the router for
      template-driven requests
- [ ] Unit tests: domain services (✅ done for all four `domain-*`
      packages, above — 53 tests via `node:test`, `pnpm test`), adapters
      (not yet — no adapters exist yet)
- [ ] Integration tests: API/producer library → event backbone → router →
      command topic → worker/projection consumer → mock provider;
      dedupe-claim redelivery test (same request id twice sends once);
      quiet-hours deferral → scheduler → re-emit test
- [ ] Reliability/observability polish (still local-only):
  - [ ] DLQ replay admin endpoint — replay re-enters the dedupe claim, not
        a raw re-send (see `messaging.md`)
  - [ ] Prometheus metrics + Grafana dashboard in compose
  - [ ] OpenTelemetry tracing across API/producer library → event backbone
        → router → command topic → worker/projection consumer. The
        bootstrap itself (`packages/observability`'s `startTracing`) is
        already built (Phase 0, above) — what's left here is calling it
        from every composition root's entrypoint and confirming a trace
        actually spans the Kafka hop end to end in Jaeger
  - [ ] Load test script (k6 or autocannon) — demonstrates the elastic
        peak-scale-out mechanism from [ADR 0002](adr/0002-message-broker-kafka.md)
        (partition count + consumer-group autoscaling), not a raw
        throughput target; its output replaces every illustrative figure
        in [`architecture/scaling-strategy.md`](architecture/scaling-strategy.md)
        with a measured one
- [ ] `docker compose up` demo works end-to-end for all four channels,
      including a broadcast (Door 2 → fan-out → many recipients) and a
      quiet-hours deferral that later re-emits

## Future work (not phased — introduce later if needed)

Deliberately left unscheduled: these require leaving "local run only,"
crossing a measured threshold that doesn't exist yet, or are load-bearing
correctness/product improvements that are cheap to retrofit later because
they're additive rather than structural.

- [ ] Independent audit consumer group + analytics consumer group, off the
      delivery path, own offsets — see
      [`architecture/messaging.md`](architecture/messaging.md#future--audit-and-analytics-sinks-deferred).
      Purely additive (a new consumer reading the existing event
      backbone), so it's cheap to add after Phase 1 rather than before.
- [ ] Channel fallback ("SMS bounced, try push") — the `Preference.fallback_order`
      column is reserved and the router is the right place to resolve it
      (see [`architecture/domain-model.md`](architecture/domain-model.md#recipient-preferences)),
      but it isn't read yet. Build once there's a real failure-rate signal
      to justify it.
- [ ] Crypto-shredding for event-log erasure — fully designed in
      [ADR 0013](adr/0013-crypto-shredding-erasure.md) and
      [`architecture/data-privacy.md`](architecture/data-privacy.md)
      (key store, encrypt-on-publish, decrypt-on-read, fail-closed
      behavior), build deferred until scheduled.
- [ ] Cassandra adapter for `NotificationRepository` / `DedupeRepository` /
      `NotificationFeedItem` — build when the thresholds in
      [`architecture/scaling-strategy.md`](architecture/scaling-strategy.md#storage-phasing)
      are actually crossed, not before. `infra-cassandra`'s port shape is
      already reserved.
- [ ] Cross-tenant provider fairness (a global provider-side budget with
      weighted per-tenant admission) — documented as a known gap in
      [`architecture/scaling-strategy.md`](architecture/scaling-strategy.md#whats-an-explicit-known-trade-off--not-solved-here);
      no current tenant profile demands it.
- [ ] Hosted free-tier demo — deploy the Phase 1 stack to free-tier
      providers (see [`architecture/infra-strategy.md`](architecture/infra-strategy.md))
      and document the live deploy + any config deltas from local
- [ ] Paid-cloud scale-out — Terraform for AWS (ECS Fargate, RDS,
      ElastiCache, Amazon MSK or self-managed Kafka, Amazon Keyspaces or
      self-managed Scylla), CD pipeline (GitHub Actions)
- [ ] Architecture diagram + live demo link in root README (once a hosted
      demo exists)
