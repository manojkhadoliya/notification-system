# services/worker-push

Consumes `command.push` and its retry tiers
(`command.push.retry-30s/-5m/-30m`) and dispatches push notifications. A
**composition root**: wires `domain-notification`'s `DispatchService`
(dedupe claim → rate limit → send → DLQ/retry-scheduling — already built
and tested) to `infra-postgres` (dedupe claims, delivery attempts),
`infra-kafka`, `infra-redis`, and `providers-push`. Structurally
identical to [`services/worker-sms`](../worker-sms/README.md) — same
`WorkerService` shape, same retry-ladder mechanics, same
rate-limited-requeue judgment call — differing only in the gateway port
and topic name it's wired to. See that package's README for the full
reasoning behind each design decision; this one only calls out what's
different.

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`PushGateway`, `NotificationRepository` (write-only here — `saveAttempt`).

## What's different from services/worker-sms

- Topics: `command.push` + `command.push.retry-30s/-5m/-30m`.
- Gateway selection: `PUSH_PROVIDER=fcm` (plus `FCM_PROJECT_ID`/
  `FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY`) selects `providers-push`'s real
  `FcmPushGateway`; anything else (including unset) defaults to
  `MockPushGateway` (`MOCK_PUSH_SUCCESS_RATE`/`MOCK_PUSH_LATENCY_MS`
  optional) — see `config.ts`. `FCM_PRIVATE_KEY` is read with literal
  `\n` sequences un-escaped to real newlines, matching how a PEM key
  typically ends up in an env-var store.
- Also sets `infra-kafka`'s `partitionsConsumedConcurrently` to `12`
  (same reasoning as `worker-sms` — see that package's README) so this
  worker's own retry-tier holds never stall its fresh `command.push`
  traffic.

## Testing

`worker-service.test.ts` exercises `WorkerService` against a real
`DispatchService` wired to in-memory fakes (`test-support.ts`). Covers
every `DispatchService` outcome, both retry-topic timing branches
(already-elapsed vs. still waiting, via injectable `now`/`sleep` seams),
malformed JSON, and an unexpected topic.

**Not yet verified against live Postgres/Kafka/Redis** — no Docker in
the session this was built in. `scripts/smoke-test.mjs` publishes a
`ChannelCommand` directly onto `command.push` and asserts a
`delivery-status` `sent` event arrives (using the mock gateway, so no
real Firebase project is needed); see that script's header comment for
the run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/worker-push build
pnpm --filter @notification-system/worker-push start     # reads .env — see .env.example
pnpm --filter @notification-system/worker-push smoke-test
```

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See topic layout, dedupe claim, and retry topology in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
