# packages/infra-kafka

Implements the `MessageBroker` port defined by `domain-notification`
(publish side only — see that port's doc comment: consuming isn't
abstracted behind a domain interface, since which topics/how to react is
inherently per-service), using [kafkajs](https://kafka.js.org/) against
Kafka. Owns the topic-name topology (`topics.ts` — the single source of
truth `KafkaMessageBroker` and every future consuming `services/*` must
agree on; mirrored in
[`infra/kafka/create-topics.sh`](../../infra/kafka/create-topics.sh)).

- **`KafkaMessageBroker`** — the port implementation. Takes an
  already-connected, idempotent `Producer` (see `createKafkaProducer`,
  which is the only correct way to construct one for this class — a bare
  `kafka.producer()` silently loses the idempotence guarantee
  messaging.md requires).
- **`KafkaConsumer`** — a thin, generic wrapper every consuming
  composition root (`router`, the channel workers,
  `projection-notification`, `scheduler`, `fanout-expander`) is expected
  to use directly, so topic subscription and message decoding stay
  consistent across all of them. **Does not** implement the retry
  ladder's "hold until the tier's backoff has elapsed" behavior (see
  `scheduleRetry`'s `x-retry-after` header) — that's business timing
  logic for the channel workers to build using this wrapper, not
  something a generic Kafka client wrapper should decide. Not yet
  built.

Depends on `shared-kernel` and `domain-notification` (to implement its
port interface); never the reverse.

## Local setup

```
pnpm compose:up                                              # starts kafka (+ postgres, redis, jaeger)
pnpm kafka:topics                                             # create every topic in the topology
pnpm --filter @notification-system/infra-kafka build
pnpm --filter @notification-system/infra-kafka smoke-test     # round-trips one message per topic
```

**Not yet verified against a live broker** — built and typechecked
without Docker available in that session. `smoke-test.mjs` produces one
message through every `MessageBroker` method and consumes all five back,
asserting the payload and the `x-retry-after` header round-trip
correctly; run it before trusting this package beyond "it typechecks."

**Delivered in:** Phase 1. Rationale for Kafka in
[ADR 0002](../../docs/adr/0002-message-broker-kafka.md); the CQRS pattern
this package's producer/consumer usage implements is in
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md); the
two-layer event/command topology in
[ADR 0009](../../docs/adr/0009-event-backbone-router.md).
