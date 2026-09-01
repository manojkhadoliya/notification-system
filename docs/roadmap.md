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
- [x] Internal producer library (Door 2) — same normalized event shape as
      Door 1's intent, no HTTP hop — see
      [`architecture/messaging.md`](architecture/messaging.md#two-doors-onto-one-backbone).
      Confirmed, building `services/fanout-expander`, to need no separate
      package: it's exactly a direct `MessageBroker.publishBroadcast(...)`
      call — `services/fanout-expander/scripts/smoke-test.mjs` is the
      concrete example (an "internal service" publishing a
      `BroadcastRequest` straight through `KafkaMessageBroker`, no HTTP
      hop). `publishBroadcast`/`publishChunk` (the two methods that make
      that real) were added to `MessageBroker` in that same PR
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
- [x] Dedupe claim (`DedupeRepository`), wired into every `worker-*`
      immediately before the gateway call — see
      [ADR 0010](adr/0010-delivery-reliability.md). The orchestration
      itself (`domain-notification`'s `DispatchService`) is already built
      and tested (above); `infra-postgres`'s `DedupeRepository` adapter
      was already built too. All four channel workers (`-sms`, `-push`,
      `-email`, `-inapp`, below) wire it identically through
      `DispatchService`
- [x] `scheduled_notifications` table (already existed, built alongside
      `services/router`'s quiet-hours deferral) + `services/scheduler`:
      the poller half — `SchedulerService.pollOnce` claims due rows via
      `SELECT ... FOR UPDATE SKIP LOCKED`, sharded by `(due_minute,
      bucket)`, and re-emits each onto `events.{critical|standard|bulk}`
      exactly as if it had just arrived — see
      [ADR 0011](adr/0011-scheduling-and-fanout.md). No Kafka
      consumer-group membership (it only ever produces); drives its own
      poll loop on `SCHEDULER_POLL_INTERVAL_MS` instead. 14 unit tests.
      **Two real gaps found and fixed while building this, not deferred:**
      `ScheduledNotification` was dropping the *original*
      `notificationRequestId` on defer (a poller re-emitting under the
      row's own id would have made every quiet-hours-deferred request
      permanently unqueryable via `GET /v1/notifications/:id` once
      `services/projection-notification` exists) and dropping
      `broadcastId` the same way (currently dormant — nothing produces a
      non-null one yet, but the same bug, so fixed alongside rather than
      rediscovered later). Also: `services/router`'s own README/this
      one had already documented jitter on deferred `dueAt` as "built in
      from the start," but nothing actually computed one — added a
      `jitter` constructor seam to `RouterService` (up to 60s, forward
      only) so that claim matches reality; see
      [`services/scheduler/README.md`](../services/scheduler/README.md)
      for the full writeup, including a documented, unresolved
      limitation (a claimed-but-never-emitted row on a publish failure
      has no automated reclaim path yet). **Not yet run against live
      Postgres/Kafka** — see that README for `smoke-test.mjs`
- [x] `services/fanout-expander`: audience descriptor → work-sized chunks
      (keyed by `chunkId`) → per-recipient events, Door 2 only — see
      [ADR 0011](adr/0011-scheduling-and-fanout.md). `MessageBroker`
      gained `publishBroadcast`/`publishChunk` (didn't exist — every
      other channel worker/router/scheduler's fakes needed the two new
      stub methods too); `domain-preferences`' `PreferenceRepository`
      gained `findRecipientIdsByTenant`, since nothing anywhere could
      resolve "every recipient for a tenant" before this. Phase 1's only
      supported `audienceDescriptor` shape is `{ "kind": "all_recipients"
      }` — no segmentation/tagging model exists yet, a deliberate
      minimal choice, not an oversight (see the package's README). Every
      id this service mints (`chunkId`, a fanned-out recipient's
      `notificationRequestId`) is deterministic, not
      `crypto.randomUUID()` — derived from stable inputs so a Kafka
      redelivery of either `events.broadcast`/`events.broadcast.chunks`
      reproduces identical ids and the existing per-worker dedupe claim
      (ADR 0010) catches the redelivery instead of double-sending; see
      `services/fanout-expander/README.md#redelivery-safety-by-construction`
      for the one case that doesn't cover (the tenant's recipient set
      actually changing between an original attempt and a redelivery).
      Also resolves the Phase 0 "internal producer library (Door 2)"
      item below — it needed no separate package, just
      `publishBroadcast` plus a direct `KafkaMessageBroker` call, which
      `scripts/smoke-test.mjs` demonstrates. 20 unit tests, including
      dedicated "a redelivery reproduces the same ids" tests. **Not yet
      run against live Postgres/Kafka** — see that README for
      `smoke-test.mjs`
- [x] `services/projection-notification`: single writer of
      `NotificationRequest.status`, ordered state machine — see
      [ADR 0010](adr/0010-delivery-reliability.md#single-writer-status).
      Consumes **only** `delivery-status`, not `events.*` + `delivery-status`
      as earlier docs (this item included) described — the router
      publishes `accepted` onto `delivery-status` itself, same topic and
      key as every other transition, which is what actually gives the
      single-writer ordering claim a real per-partition guarantee to
      stand on (`messaging.md`'s "Delivery status has one writer"
      section corrected in this PR). **A real, structural gap surfaced
      and fixed, not deferred:** `DeliveryStatusEvent` had no way to
      carry what `NotificationRequest.accept()` actually needs to
      construct a row (resolved `channel`, rendered `payload`,
      `tenantId`, `recipientId`, `notificationType`, `broadcastId`,
      `idempotencyKey`) — this service could not have been built against
      it as it stood. Turned `DeliveryStatusEvent` into a discriminated
      union: `"accepted"` (which *creates* the row) carries all of that,
      since the router is the one place it's all known at once;
      `"sent"`/`"delivered"`/`"failed"` (which only *advance* an existing
      row) stay exactly as minimal as before. Also added
      `NotificationEvent.idempotencyKey` (never threaded past ingest
      before this — `null` for anything Door 2 originated) and threaded
      it through `ScheduledNotification`/`services/scheduler`'s
      re-emission path, the same "preserve across a defer/re-emit hop"
      fix already applied to `notificationRequestId`/`broadcastId`
      there. `idempotencyKey` is now nullable on
      `NotificationRequest`/the Postgres schema too. 11 unit tests,
      covering row creation, redelivery idempotency, the full
      `accepted -> sent -> delivered` chain, and both the
      no-existing-row and regressive-transition defensive paths. **Not
      yet run against live Postgres/Kafka** — see
      [`services/projection-notification/README.md`](../services/projection-notification/README.md)
      for `smoke-test.mjs`
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
- [x] `services/worker-email`: same shape as `services/worker-sms`/
      `-push` above, against `providers-email` (mock adapter only, by
      explicit decision — see `providers-email/README.md`; `config.ts`
      has no provider-selection branch to match, only
      `MOCK_EMAIL_SUCCESS_RATE`/`MOCK_EMAIL_LATENCY_MS`). 13 unit tests.
      **Not yet run against live Postgres/Kafka/Redis** — see
      [`services/worker-email/README.md`](../services/worker-email/README.md#testing)
      for `smoke-test.mjs`
- [x] `services/worker-inapp`: consumes `command.in_app` + retry tiers.
      Structurally identical `WorkerService` to the other three workers,
      but `DispatchService`'s "gateway" is `FeedWritingInAppGateway` (this
      package's own) — writes a `NotificationFeedItem` row, then
      delegates to `infra-redis`'s `RedisInAppGateway` for the pub/sub
      nudge, rather than calling an external provider — since `in_app`
      has no provider to call (see ADR 0012). Socket holding lives in
      `services/inapp-gateway` (next item, not yet built). 17 unit tests.
      **Not yet run against live Postgres/Kafka/Redis** — see
      [`services/worker-inapp/README.md`](../services/worker-inapp/README.md#testing)
      for `smoke-test.mjs`. Building this surfaced a real gap flagged
      (not just noted) by `infra-postgres/README.md`: `domain-notification`
      had no `NotificationFeedItem` entity or `NotificationFeedRepository`
      port at all. Added both, plus the `notification_feed_items` table
      and an upsert-by-`notificationRequestId` Postgres adapter (a
      redelivered `command.in_app` message must write the same logical
      feed row again, not a duplicate — `services/worker-inapp` calls
      `save()` on every attempt, not just the first). `GET /v1/feed/...`/
      mark-read still aren't wired into `services/api` — that's a
      separate future PR; the port and adapter they need now exist
- [x] `services/inapp-gateway`: stateless WebSocket registry
      (`ConnectionRegistry`, in-memory `Map<recipientId, Set<socket>>`,
      per-instance only per ADR 0012) at `GET /v1/feed/stream?recipientId=`,
      fed by `infra-redis`'s `InAppSubscriber` on a dedicated connection.
      No Kafka membership, no domain repository ports — connection
      routing is purely mechanical, matching the ADR. 20 unit tests,
      including real (loopback, ephemeral-port) WebSocket handshake/push/
      disconnect tests in `server.ts` — there's no Fastify-`.inject()`
      equivalent for a raw `ws` upgrade, so this is the closest thing to
      a true unit test the transport allows, and it never touches
      Docker/external infra. **Not yet run against live Redis** — see
      [`services/inapp-gateway/README.md`](../services/inapp-gateway/README.md#local-setup)
      for `smoke-test.mjs`. **Real gap surfaced and flagged, not fixed
      here:** this service has no connection authentication —
      `?recipientId=` is trusted as given, so anyone who can reach it and
      knows a recipient's UUID can read that recipient's live
      notifications. Nothing in `domain-identity` models a
      recipient-scoped session/token an untrusted client could safely
      present (only a tenant-scoped API key exists, which is a backend
      secret and wrong to hand to a browser/mobile client), and ADR 0012
      deliberately keeps this service free of domain repository ports, so
      it can't look one up itself either. See
      [`services/inapp-gateway/README.md#known-phase-1-gap-no-connection-authentication`](../services/inapp-gateway/README.md#known-phase-1-gap-no-connection-authentication)
      for the full writeup and what resolving it would need (a signed
      short-lived recipient token, or an authenticating edge/BFF in
      front of it) — tracked here as a separate future item, not
      invented unscoped inside this PR
- [x] Template rendering (Handlebars) wired into the router for
      template-driven requests — `render-template.ts`, part of
      `services/router`'s original PR
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

- [ ] `services/inapp-gateway` connection authentication — a real,
      pre-existing-severity gap (not a nice-to-have): the WebSocket
      handshake trusts `?recipientId=` as given, with no verification the
      caller is that recipient. Needs a signed short-lived recipient
      token (minted by `services/api` after whatever end-user auth the
      tenant's own app performs, verified here without a repository
      lookup) or an authenticating edge/BFF proxy in front of this
      service — see
      [`services/inapp-gateway/README.md#known-phase-1-gap-no-connection-authentication`](../services/inapp-gateway/README.md#known-phase-1-gap-no-connection-authentication).
      Must be resolved before this service is reachable from anywhere
      other than a trusted internal network or a local dev box.
- [ ] `services/scheduler` reclaim for a claimed-but-never-emitted row —
      if `SchedulerService.pollOnce` fails to publish (or save) after
      claiming a row, that row stays `status = 'claimed'` forever with no
      automated path back to `'pending'`; `claimDue` only ever selects
      `'pending'` rows. A real fix needs a "claimed longer than N minutes
      ago" reclaim query in `ScheduledNotificationRepository` plus
      operational visibility to notice a stuck row exists — neither
      built yet. See
      [`services/scheduler/README.md`](../services/scheduler/README.md).
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
