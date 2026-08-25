# Roadmap

Living checklist for the build. Architecture details behind each item are in
[`architecture/`](architecture); decisions behind each choice are in
[`adr/`](adr). Per [ADR 0004](adr/0004-phased-channel-rollout.md), all four
channels are built together as one local-only phase — there is no separate
channel-rollout phasing and no committed hosted-deployment phase yet; see
"Future work" at the bottom.

## Phase 0 — Scaffolding
- [ ] Monorepo setup (pnpm workspaces, TypeScript project references)
- [ ] ESLint / Prettier config
- [ ] Package boundary rule (lint rule or dependency-cruiser) forbidding
      `domain-*` from importing `infra-*` / `providers-*`
- [ ] `docker-compose.yml` skeleton: postgres, cassandra, redis, kafka only
- [ ] CI skeleton: lint + typecheck on push

## Phase 1 — Full local build, all channels
- [ ] `domain-notification`: entities, value objects, ports
      (`NotificationRepository`, `MessageBroker`, `SmsGateway`,
      `PushGateway`, `EmailGateway`, `InAppGateway`, `RetryPolicy`)
- [ ] `domain-preferences`: `Recipient`/`Preference` entities,
      `PreferenceRepository` port, quiet-hours logic
- [ ] `domain-identity`: `Tenant`/`ApiKey` entities, `RateLimitPolicy`
- [ ] `domain-templates`: `Template`/`TemplateVersion`/`Locale` entities,
      `TemplateRepository` port
- [ ] `infra-postgres`: Prisma schema + repository adapters for
      `domain-identity`, `domain-preferences`, and `domain-templates`
- [ ] `infra-kafka`: `MessageBroker` adapter, topic/partition/retry-topic
      topology ([ADR 0008](adr/0008-elastic-scale-data-plane.md))
- [ ] `infra-cassandra`: `NotificationRepository` adapter (read-model
      projection for `domain-notification`)
- [ ] `infra-redis`: `RateLimiter` + `IdempotencyStore` adapters
- [ ] `providers-sms`: Twilio adapter + mock adapter (env-toggled)
- [ ] `providers-push`: FCM adapter + mock adapter (env-toggled)
- [ ] `providers-email`: SES/SendGrid adapter + mock adapter (env-toggled)
- [ ] `services/api`: `POST/GET /v1/notifications`, `GET/PUT /v1/preferences`,
      template management endpoints, in-app feed endpoints, producing
      directly to Kafka (no outbox relay — see ADR 0008)
- [ ] `services/projection-notification`: Kafka → `NotificationRepository` (Cassandra)
- [ ] `services/worker-sms`, `services/worker-push`, `services/worker-email`:
      consume topic, run dispatch service, retry via retry-topic tiers +
      circuit breaker
- [ ] `services/worker-inapp`: WebSocket gateway (Socket.io) + feed consumer
      (list/read/unread)
- [ ] Template rendering (Handlebars) wired into dispatch for
      template-driven requests
- [ ] Unit tests: domain services, adapters
- [ ] Integration tests: API → Kafka → worker/projection consumer → mock provider
- [ ] Reliability/observability polish (still local-only):
  - [ ] DLQ replay admin endpoint, using Kafka's log retention (see `messaging.md`)
  - [ ] Prometheus metrics + Grafana dashboard in compose
  - [ ] OpenTelemetry tracing across API → Kafka → worker/projection consumer
  - [ ] Load test script (k6 or autocannon) — demonstrates the elastic
        peak-scale-out mechanism from [ADR 0008](adr/0008-elastic-scale-data-plane.md)
        (partition count + consumer-group autoscaling), not a raw
        throughput target
- [ ] `docker compose up` demo works end-to-end for all four channels

## Future work (not phased — introduce later if needed)

Deliberately left unscheduled: these require leaving "local run only," which
is a separate decision from channel breadth (see
[ADR 0004](adr/0004-phased-channel-rollout.md)).

- [ ] Hosted free-tier demo — deploy the Phase 1 stack to free-tier
      providers (see [`architecture/infra-strategy.md`](architecture/infra-strategy.md))
      and document the live deploy + any config deltas from local
- [ ] Paid-cloud scale-out — Terraform for AWS (ECS Fargate, RDS,
      ElastiCache, Amazon MSK or self-managed Kafka, Amazon Keyspaces or
      self-managed Scylla), CD pipeline (GitHub Actions)
- [ ] Architecture diagram + live demo link in root README (once a hosted
      demo exists)
