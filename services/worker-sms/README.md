# services/worker-sms

Consumes `command.sms` and its retry tiers
(`command.sms.retry-30s/-5m/-30m`) and dispatches SMS notifications. A
**composition root**: wires `domain-notification`'s `DispatchService`
(dedupe claim → rate limit → send → DLQ/retry-scheduling — already built
and tested) to `infra-postgres` (dedupe claims, delivery attempts),
`infra-kafka`, `infra-redis`, and `providers-sms`. `WorkerService` is
what's left for this package to actually provide: telling a main-topic
message from a retry-tier one, holding the latter until its backoff
elapses, and persisting a `DeliveryAttempt` row for whichever outcomes
actually conclude an attempt.

Unlike the pre-router design, the message this worker consumes already
carries the fully rendered payload — no read-back from a read model, no
race with a projection consumer (see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md)). Preference and
quiet-hours checks already happened upstream, in `services/router` — this
worker's only decisions are the dedupe claim (via `DispatchService`) and
the retry/backoff schedule.

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`SmsGateway`, `NotificationRepository` (write-only here — `saveAttempt`).

## The retry ladder, concretely

Per [`messaging.md`](../../docs/architecture/messaging.md#retry-ladder--one-consumer-per-channel-all-tiers):
one process subscribes to `command.sms` **and** all three retry topics.

- A **main-topic** message (`attemptNumber` 1, or a redelivery of one
  already in flight) goes straight to `DispatchService.dispatch`.
- A **retry-topic** message is held — `await`ing until its
  `x-retry-after` header's timestamp (set by `KafkaMessageBroker.scheduleRetry`)
  has passed — then **re-published onto `command.sms`**, not dispatched
  directly. Every attempt goes through the exact same main-topic path
  this way, including its ordering/partitioning by `recipientId`.

Holding a message synchronously like this blocks that message's
partition for however long the wait is (up to 30 minutes on the slowest
tier) — which would stall *every other* assigned partition too under
kafkajs's default sequential consumption. `infra-kafka`'s `KafkaConsumer`
gained a `partitionsConsumedConcurrently` option for exactly this reason;
this worker sets it to `12` (4 topics × 3 partitions each, its full
assignment — see `index.ts`), so a long retry-tier wait never blocks a
fresh `command.sms` message arriving on a different partition.

## Outcomes `DispatchService.dispatch` can return, and what this worker does with each

| Outcome | This worker's action |
|---|---|
| `sent` | Save a `DeliveryAttempt` (`status: "sent"`) |
| `dead-lettered` | Save a `DeliveryAttempt` (`status: "failed"`) — `DispatchService` already published to the DLQ and `delivery-status` |
| `retry-scheduled` | Nothing — `DispatchService` already called `scheduleRetry`; *that* attempt gets its own `DeliveryAttempt` row when it eventually concludes |
| `already-claimed` | Nothing — a redelivery of a message some other instance (or an earlier run of this one) already fully handled |
| `rate-limited` | Re-queue via `messageBroker.scheduleRetry(command, 30_000)` — **at the same `attemptNumber`**, not incremented, since a rate-limit isn't a provider failure and shouldn't consume `RetryPolicy`'s attempt budget. Reuses the shortest existing retry tier rather than inventing a new topic for "briefly delayed, not a failure" |

## Real gap surfaced and fixed while building this

`infra-kafka`'s `KafkaConsumer` had no way to process assigned partitions
concurrently — every consumer (including this one) inherited kafkajs's
default of fully sequential processing. That's fine for a consumer whose
handler never blocks for long (e.g. `services/router`), but this
worker's retry-tier hold can block for up to 30 minutes, which would
have stalled its own `command.sms` traffic behind it. Added
`partitionsConsumedConcurrently` to `KafkaConsumerConfig` (optional,
defaults to kafkajs's own default of `1` — no behavior change for
existing consumers) rather than working around it here.

## Selecting a provider

`SMS_PROVIDER=twilio` (plus `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/
`TWILIO_FROM_NUMBER`) selects `providers-sms`'s real `TwilioSmsGateway`;
anything else (including unset) defaults to `MockSmsGateway`
(`MOCK_SMS_SUCCESS_RATE`/`MOCK_SMS_LATENCY_MS` optional) — see
`config.ts`.

## Testing

`worker-service.test.ts` exercises `WorkerService` against a real
`DispatchService` wired to in-memory fakes (`test-support.ts`) — same
approach used throughout this repo. Covers every outcome in the table
above, both retry-topic timing branches (already-elapsed vs. still
waiting, using injectable `now`/`sleep` seams so nothing in the suite
actually sleeps), malformed JSON, and an unexpected topic.

**Not yet verified against live Postgres/Kafka/Redis** — no Docker in
the session this was built in. `scripts/smoke-test.mjs` seeds a
`Tenant`/`Recipient` via Prisma, publishes a `ChannelCommand` directly
onto `command.sms`, and asserts a `delivery-status` `sent` event arrives
(using the mock gateway, so no real Twilio account is needed); see that
script's header comment for the run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/worker-sms build
pnpm --filter @notification-system/worker-sms start     # reads .env — see .env.example
pnpm --filter @notification-system/worker-sms smoke-test
```

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See topic layout, dedupe claim, and retry topology in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
