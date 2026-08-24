# Roadmap

Living checklist for the phased build. Architecture details behind each
phase are in [`architecture/`](architecture); decisions behind each choice
are in [`adr/`](adr).

## Phase 0 — Scaffolding
- [ ] Monorepo setup (pnpm workspaces, TypeScript project references)
- [ ] ESLint / Prettier config
- [ ] Package boundary rule (lint rule or dependency-cruiser) forbidding
      `domain-*` from importing `infra-*` / `providers-*`
- [ ] `docker-compose.yml` skeleton: postgres, redis, rabbitmq only
- [ ] CI skeleton: lint + typecheck on push

## Phase 1 — SMS + Push core pipeline (local only)
- [ ] `domain-notification`: entities, value objects, ports
      (`NotificationRepository`, `MessageBroker`, `SmsGateway`,
      `PushGateway`, `RetryPolicy`)
- [ ] `domain-preferences`: `Recipient`/`Preference` entities,
      `PreferenceRepository` port, quiet-hours logic
- [ ] `domain-identity`: `Tenant`/`ApiKey` entities, `RateLimitPolicy`
- [ ] `infra-postgres`: Prisma schema + repository adapters
- [ ] `infra-rabbitmq`: broker adapter, exchange/queue/DLQ topology
- [ ] `infra-redis`: `RateLimiter` + `IdempotencyStore` adapters
- [ ] `providers-sms`: Twilio adapter + mock adapter (env-toggled)
- [ ] `providers-push`: FCM adapter + mock adapter (env-toggled)
- [ ] `services/api`: `POST/GET /v1/notifications`, `GET/PUT /v1/preferences`,
      outbox relay
- [ ] `services/worker-sms`, `services/worker-push`: consume queue, run dispatch
      service, retry + backoff + circuit breaker
- [ ] Unit tests: domain services, adapters
- [ ] Integration tests: API → queue → worker → mock provider
- [ ] `docker compose up` demo works end-to-end

## Phase 1.5 — Hosted free-tier demo
- [ ] Deploy Phase 1 stack to free-tier providers (see
      [`architecture/infra-strategy.md`](architecture/infra-strategy.md))
- [ ] Document the live deploy + any config deltas from local

## Phase 2 — Email + In-app channels
- [ ] `domain-templates` bounded context (Template, TemplateVersion,
      Locale)
- [ ] `providers-email`: SES/SendGrid adapter + mock adapter
- [ ] `services/worker-email`
- [ ] In-app: WebSocket gateway (Socket.io), notification feed API
      (list/read/unread), `services/worker-inapp`
- [ ] Template management API + Handlebars rendering

## Phase 3 — Reliability & observability polish
- [ ] DLQ replay admin endpoint
- [ ] Prometheus metrics + Grafana dashboard in compose
- [ ] OpenTelemetry tracing across API → queue → worker
- [ ] Load test script (k6 or autocannon)
- [ ] Optional: Kafka event bus for audit/replay, additive to RabbitMQ

## Phase 4 — Optional paid-cloud scale-out (not committed)
- [ ] Terraform for AWS (ECS Fargate, RDS, ElastiCache, Amazon MQ)
- [ ] CD pipeline (GitHub Actions)
- [ ] Architecture diagram + live demo link in root README
