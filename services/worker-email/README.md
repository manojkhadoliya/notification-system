# services/worker-email

Consumes `command.email` and its retry tiers
(`command.email.retry-30s/-5m/-30m`) and dispatches email notifications. A
**composition root**: wires `domain-notification`'s `DispatchService`
(dedupe claim → rate limit → send → DLQ/retry-scheduling — already built
and tested) to `infra-postgres` (dedupe claims, delivery attempts),
`infra-kafka`, `infra-redis`, and `providers-email`. Structurally
identical to [`services/worker-sms`](../worker-sms/README.md) — same
`WorkerService` shape, same retry-ladder mechanics, same
rate-limited-requeue judgment call — differing only in the gateway port
and topic name it's wired to. See that package's README for the full
reasoning behind each design decision; this one only calls out what's
different.

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`EmailGateway`, `NotificationRepository` (write-only here — `saveAttempt`).

## What's different from services/worker-sms

- Topics: `command.email` + `command.email.retry-30s/-5m/-30m`.
- **No provider-selection branch** — `providers-email` currently ships
  only `MockEmailGateway`; a real SES/SendGrid adapter is deliberately
  deferred (see `providers-email/README.md`). `config.ts` has no
  `EMAIL_PROVIDER` var to match; only `MOCK_EMAIL_SUCCESS_RATE`/
  `MOCK_EMAIL_LATENCY_MS`, both optional. When a real adapter lands in
  `providers-email`, this package's `index.ts` gains the same
  config-driven `kind: "mock" | "..."` branch `worker-sms`/`worker-push`
  already have.
- Also sets `infra-kafka`'s `partitionsConsumedConcurrently` to `12`
  (same reasoning as `worker-sms` — see that package's README) so this
  worker's own retry-tier holds never stall its fresh `command.email`
  traffic.

## Testing

`worker-service.test.ts` exercises `WorkerService` against a real
`DispatchService` wired to in-memory fakes (`test-support.ts`). Covers
every `DispatchService` outcome, both retry-topic timing branches
(already-elapsed vs. still waiting, via injectable `now`/`sleep` seams),
malformed JSON, and an unexpected topic.

**Not yet verified against live Postgres/Kafka/Redis** — no Docker in
the session this was built in. `scripts/smoke-test.mjs` publishes a
`ChannelCommand` directly onto `command.email` and asserts a
`delivery-status` `sent` event arrives (the mock gateway is the only
adapter this package has); see that script's header comment for the run
steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/worker-email build
pnpm --filter @notification-system/worker-email start     # reads .env — see .env.example
pnpm --filter @notification-system/worker-email smoke-test
```

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See topic layout, dedupe claim, and retry topology in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
