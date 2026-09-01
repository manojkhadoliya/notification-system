# services/fanout-expander

Resolves a broadcast into individual per-recipient events, in two stages.
A **composition root**: no business logic beyond descriptor resolution,
chunking, and expansion.

1. Consumes `events.broadcast` (Door 2 only — internal services, not the
   tenant-facing API; see
   [`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#broadcast-is-door-2-only)),
   one message per broadcast request carrying an `audienceDescriptor`
   instead of a single `recipientId`. Resolves the descriptor
   (`AudienceResolver`) and splits the result into work-sized chunks
   (`domain-notification`'s `splitIntoChunks` — capped at 200 recipients,
   sized by *work* rather than raw recipient count, since each recipient
   can fan out to up to 4 channel commands) — republished as
   `BroadcastChunk`s onto `events.broadcast.chunks`, keyed by `chunkId`.
2. Consumes `events.broadcast.chunks` and expands each chunk into
   individual per-recipient `NotificationEvent`s, republished onto
   `events.{critical|standard|bulk}` keyed by `recipientId` — the same
   shape either door produces normally, so `services/router` treats a
   fanned-out recipient identically to any other event. Each expanded
   recipient gets its own `notificationRequestId` and a `broadcastId`
   back-reference.

**Depends on (ports):** `MessageBroker`, `PreferenceRepository` (via
`AudienceResolver`, below).

## Redelivery safety, by construction

Every other `notificationRequestId`/`chunkId` in this system is a fresh
`crypto.randomUUID()`. This service's are not — they're `deterministicId`
(`src/deterministic-id.ts`) derived from stable inputs: a chunk's id from
`broadcastId` + its position in the split, an expanded event's
`notificationRequestId` from `chunkId` + `recipientId`. Combined with
`PreferenceAudienceResolver`'s stable (`ORDER BY id`) audience resolution,
a Kafka redelivery of either topic — which *will* happen under normal
at-least-once delivery — reproduces the exact same chunk boundaries and
the exact same per-recipient ids every time. That means the dedupe claim
every channel worker already takes before calling a provider (ADR 0010)
recognizes a redelivered fan-out the same way it recognizes any other
redelivered message — "already claimed," not "send it again."

**What this doesn't cover:** if the tenant's actual recipient set changes
between an original attempt and a redelivery (someone added/removed
mid-broadcast), stage 1's chunk boundaries can shift for rows after the
change, which can change which chunk (and therefore which
deterministically-derived ids) a recipient lands in. Not solved here — a
real, documented gap, not a silently-assumed-away one. In practice this
only matters for the rare redelivery racing a live audience change, not
the common case.

## Judgment calls worth knowing about

- **Audience descriptors support exactly one shape for Phase 1:
  `{ "kind": "all_recipients" }`**, resolved via
  `PreferenceRepository.findRecipientIdsByTenant` — every recipient
  belonging to the broadcast's tenant. `audienceDescriptor` is `Record<string,
  unknown>` and deliberately opaque to `domain-notification` (see
  `BroadcastRequest`'s doc comment); nothing in this system has a
  segmentation/tagging model to filter on yet, so anything richer
  (`"opted into channel X"`, `"tagged VIP"`, etc.) isn't buildable until
  that data exists. An unrecognized `kind` throws — `AudienceResolver`'s
  caller catches it, logs, and skips the broadcast (same "data problem,
  not retried forever" treatment `services/router` gives an unresolvable
  `templateVersionId`), rather than silently firing to an empty or wrong
  audience.
- **A broadcast never specifies a channel override or renders a
  template.** `BroadcastRequest`/`BroadcastChunk` carry neither field —
  every fanned-out recipient goes through `services/router`'s normal
  auto-pick-a-channel path with `templateVersionId: null`. A real
  limitation, not an oversight; extending it is an additive schema change
  to `BroadcastRequest`, not something to improvise here.
- **`findRecipientIdsByTenant` loads the whole result into memory in one
  query, not a cursor/stream.** Fine at local/demo scale; a real gap for
  a tenant with a very large recipient set. Revisit if that's ever
  actually hit — see the port's own doc comment in
  `domain-preferences/src/ports.ts`.
- **"The producer library (Door 2)"** (see `docs/roadmap.md`'s Phase 0
  entry) turned out to need no new package: it's exactly what this
  package's own `scripts/smoke-test.mjs` does to publish a test broadcast
  — a direct `KafkaMessageBroker.publishBroadcast(...)` call, no HTTP hop.
  `MessageBroker.publishBroadcast`/`publishChunk` (added in this PR) are
  the two methods that make that "thin wrapper" real.

## Testing

`FanoutExpanderService`'s both stages, `PreferenceAudienceResolver`, and
`deterministic-id.ts` are all directly unit-tested (20 tests) against
in-memory fakes — including both "redelivery produces identical ids"
tests that prove the redelivery-safety design actually holds.

**Not yet run against live Postgres/Kafka** — no Docker in the session
this was built in. `scripts/smoke-test.mjs` seeds a Tenant + 3 Recipients,
publishes a broadcast, and asserts 3 individual `events.standard`
messages arrive, one per recipient, each with a distinct
`notificationRequestId` and the same `broadcastId`; see that script's
header comment for the run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/fanout-expander build
pnpm --filter @notification-system/fanout-expander start     # reads .env — see .env.example
pnpm --filter @notification-system/fanout-expander smoke-test
```

**Delivered in:** Phase 1. Design and rationale in
[ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md).
