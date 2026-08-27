# ADR 0011: Scheduling and fan-out — deferred sends and broadcast

## Status
In Progress

## Context
Two gaps in the original design share a root cause: nothing holds a
message that isn't ready to send right now.

- **No deferral mechanism.** `domain-preferences` models `QuietHours` as a
  value object, but nothing acts on it — there's no scheduler, no
  `due_at`, no digest. In practice, quiet hours can only become a silent
  drop or a retry-ladder trip into the DLQ, neither of which is what
  "quiet hours" should mean. The same gap blocks "remind me in 3 days" or
  a daily/weekly digest — anything that isn't "send now."
- **No fan-out.** The API accepts one recipient per request. A tenant
  announcing to a million recipients means a million authenticated HTTP
  calls, a million idempotency keys, a million Redis writes — from an
  external client, over the internet — making the ingest tier and the
  idempotency store the bottleneck for the single most common high-volume
  pattern a notification platform sees.

## Decision

**Scheduled deferral store.** A Postgres table, `scheduled_notifications`,
keyed by `due_at`, holds a deferred `NotificationRequest` — distinct from
the Kafka retry ladder, which is a different timescale and mechanism (seconds
to minutes, failure-driven) and shouldn't be merged with this one (minutes
to days, policy-driven). When the router's quiet-hours check defers a
message, it writes a row here instead of dropping it or proceeding. A
poller (`services/scheduler`) claims due rows with `SELECT ... FOR UPDATE
SKIP LOCKED`, shards its claim query by `(due_minute, bucket)`, and jitters
`due_at` at write time — sharding and jitter are built in from the start,
not added after a thundering-herd incident, because a naive single-bucket
poller (every digest recipient's row due inside the same minute, off one
index) is a known failure mode at scale. Claimed rows are re-emitted onto
`events.{critical|standard|bulk}`, entering the normal router pipeline
exactly as if they'd just arrived.

**Chunked fan-out.** Broadcast is Door 2 only (see
[ADR 0009](0009-event-backbone-router.md)) — an internal service resolves
an audience and calls the producer library with an `audienceDescriptor`
instead of a single `recipientId`. `services/fanout-expander` resolves the
descriptor server-side, in two stages: first into work-sized chunks
(capped at 200 recipients, sized by *work* — each recipient can fan out to
up to 4 channel commands — not raw recipient count), published on
`events.broadcast.chunks` keyed by `chunkId`; then each chunk into
individual per-recipient events, republished on `events.*` keyed by
`recipientId`, each with its own `notificationRequestId` and a
`broadcastId` back-reference. `chunkId` keying is a documented exception to
the recipientId-keying rule everywhere else on the backbone — a chunk
carries many recipients and can't honestly be keyed by any single one of
them.

## Rationale
- **Different store, different mechanism, on purpose.** A broker isn't
  built to be a calendar — holding a delayed message in Kafka for hours or
  days is fragile and, unlike Postgres, isn't queryable by `due_at` for
  operational visibility ("what's coming due in the next hour"). Reusing
  the retry ladder for deferral would conflate two mechanisms with
  different failure semantics: a retry is triggered by failure and self-
  bounds at `maxAttempts`; a deferral is triggered by policy and has no
  failure to bound.
- **Sharding and jitter from day one, not as a later fix.** The failure
  mode (a default digest hour putting every recipient's row due inside one
  minute, polled by a single process off a single index) is well
  understood and cheap to design around before the poller exists. Adding
  it after the fact means retrofitting against production data, which is
  strictly more expensive.
- **Chunk size by work, not head count.** A chunk of 200 recipients that
  each fan out to 4 channels is 800 units of downstream work — the same
  order of magnitude as a naively-sized chunk of 1,000 single-channel
  recipients. Sizing by head count alone understates the real load a chunk
  produces once channel fan-out is accounted for.
- **Re-entering the normal event backbone, not a side path.** A
  fanned-out or re-emitted-from-schedule recipient goes through the exact
  same router logic (preferences, quiet hours again, template render) as
  any other event — no special case for "this one came from a broadcast"
  needs to exist anywhere downstream of the expander/poller.

## Alternatives considered
- **Quiet-hours suppression as a silent drop.** Simplest to build, but
  isn't what "quiet hours" means to a recipient who opted into a time
  window, not into never receiving the notification.
- **Un-sharded, un-jittered poller (the donor design's original
  pattern).** Simpler until real digest volume exists, then a known
  thundering-herd failure mode. Rejected specifically because this system
  has the chance to build it correctly from the start rather than
  retrofitting after the failure is observed.
- **Chunk size capped at 1,000 recipients (uncorrected from reference
  material).** Doesn't account for per-recipient channel fan-out; 200,
  work-sized, is the corrected number.
- **Broadcast accepted on Door 1 as well as Door 2.** Considered and
  rejected for now — see [ADR 0009](0009-event-backbone-router.md) and
  [`messaging.md`](../architecture/messaging.md#broadcast-is-door-2-only).
  The fan-out mechanism itself is identical either way, so this can be
  revisited without touching this ADR's decision.

## Consequences
- New table: `scheduled_notifications`. Stays on Postgres permanently — see
  [`scaling-strategy.md`](../architecture/scaling-strategy.md#storage-phasing).
- New topics: `events.broadcast` (keyed by `broadcastId`),
  `events.broadcast.chunks` (keyed by `chunkId`, documented exception to
  recipientId keying).
- New composition roots: `services/scheduler`, `services/fanout-expander`.
- `NotificationRequest` gains a nullable `broadcast_id` back-reference
  column.
