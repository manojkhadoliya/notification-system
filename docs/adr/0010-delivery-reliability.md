# ADR 0010: Delivery reliability — dedupe claim, retry topology, single-writer status

## Status
In Progress

## Context
Three separate reliability gaps existed in the pre-router design, all on
the delivery path, all invisible on a low-traffic local Compose stack:

1. **No dedupe before the provider call.** The only idempotency mechanism
   was ingest-time (`Idempotency-Key` in Redis, ~24h TTL) plus Kafka's
   idempotent-producer mode. Neither protects the send itself — a worker
   that calls a provider and dies before committing its offset gets
   redelivered on rebalance (Kafka's at-least-once default guarantees this
   eventually happens) and sends a second time.
2. **Unclear retry-tier ownership.** The design implied "a lightweight
   delay-aware consumer on each retry topic," without specifying whether
   that meant one process per tier or one process per channel across
   tiers — a decision with real deployment-complexity consequences (4
   processes vs. 12) that shouldn't be left implicit.
3. **`status` had two independent writers.** The read-model projection
   wrote `accepted`; workers independently wrote `sent`/`delivered`, from a
   different consumer group, with no ordering between the two. An
   eventually consistent store resolves same-cell writes last-write-wins by
   timestamp — a lagging `accepted` write could land after a `delivered`
   write and regress the row. "Idempotent upsert" guards against
   duplicates; it doesn't guard against going backwards, and only one of
   those properties was built.

## Decision

**Dedupe claim.** Immediately before calling the channel gateway, the
worker claims a conditional write on `(tenantId, notificationRequestId,
recipientId, channel)` via `DedupeRepository` (Postgres unique constraint
for Phase 1; see
[`scaling-strategy.md`](../architecture/scaling-strategy.md#storage-phasing)
for the move-to-partitioned-KV threshold). The claim happens in the
worker, not the router and not at ingest: claiming earlier risks losing
the notification permanently if the process dies after claiming but before
the command is even published. This is a **correctness invariant** — claim
placement and claim key shape don't get revisited without new evidence
that the failure mode itself has changed, unlike the tuning choices below.

**Implementation note, added during Phase 1 (`domain-notification`'s
`DispatchService`):** the claim key has no `attemptNumber` — it's
`(tenantId, notificationRequestId, recipientId, channel)`, full stop (see
[`data-model.md`](../architecture/data-model.md#notification-delivery-core-domain)).
Read literally, "claim before every gateway call" would mean a legitimate
retry (attempt 2, after attempt 1's provider call genuinely failed) finds
the key already taken and incorrectly treats that as "already sent."
`DispatchService` resolves this by claiming only on `attemptNumber === 1`;
later attempts are the same logical send already holding the claim, and go
straight to the gateway call. This still closes the gap this ADR names — a
Kafka redelivery of the *same* attempt-1 message finds the claim taken and
skips the gateway call — it just doesn't additionally block a *different*,
later attempt from proceeding. **This is a Phase 1 implementation decision,
not a re-litigation of the invariant above**, but it's the kind of detail
the invariant's key shape left implicit; flagged here so it's reviewed
deliberately rather than inherited from a code comment. The alternative —
a claim that tracks in-flight/succeeded status instead of a one-shot
insert — is a real option if this reading turns out to be wrong.

**Retry topology.** One process per channel, not one per tier: each
channel worker (`worker-sms`, `worker-push`, `worker-email`,
`worker-inapp`) subscribes to its own `command.{channel}` topic and all
three of that channel's retry topics
(`command.{channel}.retry-30s/-5m/-30m`), holding a message
(delay-aware, not busy-polling) until its tier's backoff elapses, then
re-producing to `command.{channel}`. Four retry-aware workers are simpler
to deploy and monitor than twelve single-tier ones, and an idling consumer
isn't a real cost at this system's target scale. This is a load-dependent
choice, not an invariant — revisit if a load test shows one tier's backlog
starving another's on the same process.

**Single-writer status.** `services/projection-notification` becomes the
**only** writer of `NotificationRequest.status`. It consumes both
`events.*` (for the `accepted` transition, published by the router) and a
new `delivery-status` topic (for `sent`/`delivered`/`failed`, published by
channel workers), and applies an ordered state machine — `accepted → sent
→ delivered`, never backwards — rather than a plain upsert.

## Rationale
- **Claim-before-call is the only point that actually prevents a duplicate
  send.** Ingest-time idempotency and Kafka's producer-side idempotence
  both guard against duplicate *writes*; neither guards the external
  side effect, which is the part that costs money (SMS/push provider
  billing) and annoys recipients. A conditional claim immediately before
  the gateway call is the narrowest point that covers the actual failure
  mode (crash between provider call and offset commit), and it makes DLQ
  replay safe for free — replay re-attempts the claim instead of
  unconditionally re-sending.
- **One process per channel is a complexity trade, not a correctness
  one.** Nothing about correctness requires per-tier isolation; it only
  affects how quickly a backed-up tier's messages get picked up relative
  to other tiers on the same process. Given this system's target scale,
  simpler deployment wins by default.
- **A single writer is the only way to guarantee monotonicity.** Two
  writers to the same eventually-consistent cell, with no coordination
  between them, cannot be made monotonic by making each writer more
  idempotent — idempotence and ordering are different properties.
  Consuming both source topics from one consumer group is what lets the
  state machine see every transition and reject an out-of-order one.

## Alternatives considered
- **Dedupe claim at ingest instead of in the worker.** Simpler (one
  check, one place), but doesn't protect the actual send — a request can
  be accepted once and still dispatched twice if the worker crashes after
  its own successful provider call but before committing its offset.
  Ingest-time dedup and the worker-side claim solve different problems and
  both are needed.
- **One consumer per retry tier (12 processes).** More isolation — a
  backed-up 30m tier can't slow down 30s processing — at the cost of more
  to deploy and monitor for a benefit that doesn't show up at this
  system's target scale. Rejected for now; revisit with load-test evidence
  if it's ever needed.
- **Status as a plain idempotent upsert (the original design).** Simplest
  to write, but only solves duplicates, not ordering — the exact gap that
  caused the regression this ADR fixes.

## Consequences
- New port: `DedupeRepository`, implemented by `infra-postgres`
  (`dedupe_claims` table) for Phase 1. See
  [`data-model.md`](../architecture/data-model.md#notification-delivery-core-domain).
- New topic: `delivery-status`, keyed by `notificationRequestId`. See
  [`messaging.md`](../architecture/messaging.md#topic-layout).
- `services/projection-notification`'s consumer-group membership expands
  to include `delivery-status` alongside `events.*`; its write path changes
  from upsert to an explicit state-machine transition.
- Each channel worker owns retry-topic consumption for its own channel —
  no separate `services/retry-*` processes.
