# Roadmap

Living checklist for the build. Architecture details behind each item are in
[`architecture/`](architecture); decisions behind each choice are in
[`adr/`](adr). Per [ADR 0004](adr/0004-channel-rollout.md), all four
channels are built together as one local-only phase — there is no separate
channel-rollout phasing and no committed hosted-deployment phase yet; see
"Future work" at the bottom.

## Phase 0 — Scaffolding
- [ ] Monorepo setup (pnpm workspaces, TypeScript project references)
- [ ] ESLint / Prettier config
- [ ] Package boundary rule (lint rule or dependency-cruiser) forbidding
      `domain-*` from importing `infra-*` / `providers-*`
- [ ] `docker-compose.yml` skeleton: postgres, redis, kafka only —
      Cassandra deferred, see
      [`architecture/scaling-strategy.md`](architecture/scaling-strategy.md#storage-phasing)
      and [ADR 0003](adr/0003-polyglot-persistence.md)
- [ ] Kafka topic creation matching the actual topology: `events.critical`
      / `.standard` / `.bulk`, `events.broadcast`,
      `events.broadcast.chunks`, `command.{sms|push|email|in_app}` +
      their `.retry-30s`/`.retry-5m`/`.retry-30m`/`.dlq`, `delivery-status`
      — see [`architecture/messaging.md`](architecture/messaging.md#topic-layout)
- [ ] Internal producer library (Door 2) — same normalized event shape as
      Door 1's intent, no HTTP hop — see
      [`architecture/messaging.md`](architecture/messaging.md#two-doors-onto-one-backbone)
- [ ] CI skeleton: lint + typecheck on push

## Phase 1 — Full local build, all channels
- [ ] `domain-notification`: entities, value objects, ports
      (`NotificationRepository`, `DedupeRepository`,
      `ScheduledNotificationRepository`, `MessageBroker`, `SmsGateway`,
      `PushGateway`, `EmailGateway`, `InAppGateway`, `RetryPolicy`)
- [ ] `domain-preferences`: `Recipient`/`Preference` entities,
      `PreferenceRepository` port, quiet-hours logic (`fallback_order`
      column reserved on `Preference`, not read yet — see
      [`architecture/domain-model.md`](architecture/domain-model.md#recipient-preferences))
- [ ] `domain-identity`: `Tenant`/`ApiKey` entities, `RateLimitPolicy`
- [ ] `domain-templates`: `Template`/`TemplateVersion`/`Locale` entities,
      `TemplateRepository` port
- [ ] `infra-postgres`: Prisma schema + repository adapters for
      `domain-identity`, `domain-preferences`, `domain-templates`, and —
      for Phase 1 — `domain-notification`'s `NotificationRepository` /
      `DedupeRepository` / `ScheduledNotificationRepository` (see
      [ADR 0003](adr/0003-polyglot-persistence.md), revised)
- [ ] `infra-kafka`: `MessageBroker` adapter, event/command/retry-topic
      topology ([ADR 0002](adr/0002-message-broker-kafka.md),
      [ADR 0009](adr/0009-event-backbone-router.md))
- [ ] `infra-redis`: `RateLimiter` + `IdempotencyStore` adapters, plus a
      pub/sub adapter for `worker-inapp` ↔ `inapp-gateway` (see
      [ADR 0012](adr/0012-inapp-gateway-split.md))
- [ ] `providers-sms`: Twilio adapter + mock adapter (env-toggled)
- [ ] `providers-push`: FCM adapter + mock adapter (env-toggled)
- [ ] `providers-email`: SES/SendGrid adapter + mock adapter (env-toggled)
- [ ] `services/api`: `POST/GET /v1/notifications` (Door 1 — accepts an
      intent, one `recipientId`, optional channel override; no audience
      descriptor — see [`architecture/api-spec.md`](architecture/api-spec.md)),
      `GET/PUT /v1/preferences`, template management endpoints, in-app
      feed endpoints, producing to the event backbone (no outbox relay —
      see ADR 0008)
- [ ] `services/router` (new) — preferences + quiet hours + channel
      resolution + template render, publishes self-contained
      `command.*` — see [ADR 0009](adr/0009-event-backbone-router.md).
      **The single largest structural item in this phase.**
- [ ] Dedupe claim (`DedupeRepository`), wired into every `worker-*`
      immediately before the gateway call — see
      [ADR 0010](adr/0010-delivery-reliability.md)
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
- [ ] `services/worker-sms`, `services/worker-push`, `services/worker-email`:
      consume `command.{channel}` + all three of that channel's retry
      tiers (one process per channel, not per tier — see
      [ADR 0010](adr/0010-delivery-reliability.md)), dedupe claim → dispatch
      → publish outcome to `delivery-status`, circuit breaker
- [ ] `services/worker-inapp`: consume `command.in_app` + retry tiers,
      dedupe claim, write `NotificationFeedItem`, publish to Redis
      pub/sub — socket holding moved out, see next item
- [ ] `services/inapp-gateway` (new): stateless WebSocket registry,
      subscribes to Redis pub/sub, pushes to connected recipients — see
      [ADR 0012](adr/0012-inapp-gateway-split.md)
- [ ] Template rendering (Handlebars) wired into the router for
      template-driven requests
- [ ] Unit tests: domain services, adapters
- [ ] Integration tests: API/producer library → event backbone → router →
      command topic → worker/projection consumer → mock provider;
      dedupe-claim redelivery test (same request id twice sends once);
      quiet-hours deferral → scheduler → re-emit test
- [ ] Reliability/observability polish (still local-only):
  - [ ] DLQ replay admin endpoint — replay re-enters the dedupe claim, not
        a raw re-send (see `messaging.md`)
  - [ ] Prometheus metrics + Grafana dashboard in compose
  - [ ] OpenTelemetry tracing across API/producer library → event backbone
        → router → command topic → worker/projection consumer
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
