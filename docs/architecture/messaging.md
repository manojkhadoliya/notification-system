# Messaging — Kafka Topology

Accessed only through the domain-owned `MessageBroker` port
(`domain-notification`); implemented by `infra-kafka`. Services never talk
to a Kafka client library directly.

## Why Kafka

[ADR 0002](../adr/0002-message-broker-kafka.md) picks Kafka so that
absorbing a traffic burst is a partition/consumer capacity change, not a
broker redesign. [ADR 0009](../adr/0009-event-backbone-router.md) builds on
that: a single router sits between ingest and the channel topics, so every
channel/quiet-hours/template decision happens once, before a message is
committed downstream — not independently, after commit, inside every
worker. [ADR 0008](../adr/0008-notification-delivery-cqrs.md) still holds
for the write/read split; what changes is that the read-model projection it
describes is no longer anything the delivery path waits on (see "What
changed from ADR 0008" below).

## Two doors onto one backbone

```
 DOOR 1 — external tenants              DOOR 2 — internal services
 POST /v1/notifications                 producer library (no HTTP hop)
 tenant-authenticated, idempotent        imports the same MessageBroker
 one recipientId per request             port Door 1 uses
 (no audienceDescriptor — see
  "Broadcast is Door 2 only" below)      emits a domain fact:
                                           eventType, tenantId, recipientId,
                                           notificationType, payload
        │                                        │
        └─────────────────┬──────────────────────┘
                           ▼
              events.{critical|standard|bulk}
              key: recipientId  (broadcast + chunk carriers: see below)
              payload BY REFERENCE, long retention
                           │
                           ▼
                  ROUTER (services/router)
        preferences + quiet hours + template render + channel resolution
                           │
                           ▼
              command.{sms|push|email|in_app}
              key: recipientId
              SELF-CONTAINED rendered payload, short retention
                           │
                  channel workers (dedupe → provider)
```

Both doors normalize onto the same event shape before the router ever sees
a message — from that point on there is exactly one code path, regardless
of which door a message came in through.

## Topic layout

```
Event backbone (upstream of the router):
  events.critical   events.standard   events.bulk
  (N partitions each, keyed by recipientId)

Broadcast (Door 2 only — see "Broadcast is Door 2 only" below):
  events.broadcast          (keyed by broadcastId — one message per broadcast)
  events.broadcast.chunks   (keyed by chunkId — documented exception to the
                              recipientId-keying rule; a chunk carries many
                              recipients and can't honestly be keyed by one)

Command topics (downstream of the router — what workers consume):
  command.sms      command.push      command.email      command.in_app
  (N partitions each, keyed by recipientId)

Retry, per channel, one topic per backoff tier (replaces RabbitMQ's
per-queue TTL + dead-letter exchange):
  command.sms.retry-30s     command.sms.retry-5m     command.sms.retry-30m     command.sms.dlq
  command.push.retry-30s    command.push.retry-5m    command.push.retry-30m    command.push.dlq
  command.email.retry-30s   command.email.retry-5m   command.email.retry-30m   command.email.dlq
  command.in_app.retry-30s  command.in_app.retry-5m  command.in_app.retry-30m  command.in_app.dlq

Delivery outcomes (channel workers → the single status writer):
  delivery-status   (keyed by notificationRequestId)
```

`command.in_app` is consumed by `services/worker-inapp` instead of a
`worker-*` following the SMS/Push/Email pattern exactly — see "In-app is
structurally different" below.

Event and command topics are partitioned by `recipientId`, not `tenantId`:
this keeps one recipient's messages in order on one partition (the ordering
guarantee that actually matters), while spreading a single large tenant's
traffic across many partitions automatically, since that tenant's own
recipients already hash to different keys. See
[`scaling-strategy.md`](scaling-strategy.md#why-the-kafka-partition-key-is-recipientid-not-tenantid)
for the full reasoning; it applies identically to the new topic set.

## Broadcast is Door 2 only

`POST /v1/notifications` (Door 1) accepts exactly one `recipientId` per
call — no audience descriptor. A tenant that wants to notify many
recipients does so through an internal service that resolves the audience
and calls the producer library (Door 2) with an `audienceDescriptor`
instead of a `recipientId`. This keeps the platform's highest-blast-radius
operation behind something the platform team controls, rather than exposed
directly to external callers. If self-service tenant broadcast is ever
needed, it's an additive change to Door 1's request shape — the fan-out
mechanism below is unchanged either way.

## Router

`services/router` is the single decision point, consuming
`events.critical`/`events.standard`/`events.bulk`. For each event:

1. Resolve `tenantId` + recipient preferences (`PreferenceRepository`,
   Redis-cached read-through — see
   [`scaling-strategy.md`](scaling-strategy.md#keeping-postgres-off-the-hot-path)).
2. Quiet-hours check. If the recipient is inside a quiet-hours window and
   the notification isn't `critical` priority, write a row to
   `scheduled_notifications` (`due_at` = end of the window) instead of
   proceeding — see [`data-model.md`](data-model.md#scheduled_notifications)
   and [ADR 0011](../adr/0011-scheduling-and-fanout.md). Nothing is
   dropped and nothing loops through the retry ladder for a suppression
   that was never a failure.
3. Channel resolution. An explicit channel on the event (from Door 1, or a
   Door 2 fact with a channel override) is honored as a *requested*
   channel, not a bypass — still checked against that recipient's opt-out
   for that channel/notification-type. If no channel is specified, the
   router picks from the recipient's opted-in channels for that
   `notificationType`.
4. Template render, if `templateVersionId` is present (or resolved by
   `notificationType` + channel) — via `domain-templates`'
   `TemplateRepository`. The rendered content becomes the command payload;
   see "Self-contained command payload" below.
5. Publish to `command.{channel}`, keyed by `recipientId`, and publish an
   `accepted` outcome to `delivery-status` (see "Delivery status has one
   writer" below).

## Self-contained command payload

The command message carries the **fully rendered** payload — not a
reference the worker looks up elsewhere. This replaces the earlier design,
where the Kafka envelope was kept "intentionally thin" and the worker
loaded the request body back from the Cassandra-backed projection: that
projection is written by a separate consumer group with no ordering
guarantee against the worker, so the worker's normal case was reading a
payload that hadn't been written yet, which fails closed into the retry
ladder — adding load to the exact two components already behind. Rendering
once, in the router, and publishing the result removes the dependency
entirely: a command is an instruction with a lifetime of seconds, not a
second source of truth for request content. See
[ADR 0009](../adr/0009-event-backbone-router.md).

The event-backbone topics (`events.*`) still carry payload **by
reference** (ids + template variable keys, not rendered content) — that's
what keeps the long-retention log's PII footprint small; see
[`data-privacy.md`](data-privacy.md). Only the short-retention command
topics carry the rendered result.

## Dedupe claim, before the provider call

`IdempotencyStore` (Redis, ~24h TTL) at ingest protects against duplicate
*requests*. It does not protect against a duplicate *send*: a worker that
calls a provider and dies before committing its offset gets redelivered on
rebalance — Kafka's at-least-once default guarantees this eventually
happens — and would otherwise send twice.

Immediately before calling the channel gateway, the worker claims a
conditional write on `(tenantId, notificationRequestId, recipientId,
channel)` via `DedupeRepository`. The claim happens in the worker, not the
router and not at ingest — claiming earlier risks losing the notification
permanently if the process dies after claiming but before the command is
even published. This also makes DLQ replay safe: replaying a message means
re-attempting the claim, not re-sending unconditionally. See
[ADR 0010](../adr/0010-delivery-reliability.md) — this is a correctness
invariant, not a load-dependent tuning choice.

## Message flow

1. Door 1 or Door 2 normalizes into the shared event shape and produces to
   `events.{critical|standard|bulk}`, keyed by `recipientId` (or
   `events.broadcast`, keyed by `broadcastId`, for an audience descriptor —
   see "Fan-out" below), with the Kafka client's idempotent-producer mode
   enabled.
2. The router (above) resolves preferences, quiet hours, channel, and
   template, then publishes a self-contained command to
   `command.{channel}`.
3. The matching worker (`worker-sms` / `worker-push` / `worker-email`, or
   `worker-inapp` for `in_app`) consumes `command.{channel}` (own consumer
   group), claims the dedupe key, and calls the channel gateway port.
4. On success: the worker publishes a `sent` (and later, via webhook for
   SMS, `delivered`) outcome to `delivery-status`. `worker-inapp` also
   writes the `NotificationFeedItem` row directly — see "In-app is
   structurally different."
5. On failure: the worker produces to that channel's next retry-tier topic
   with the delay implied by `RetryPolicy`. The same worker process
   consumes its own retry topics (see "Retry ladder" below) — there is no
   separate retry-relay service per tier.
6. After `RetryPolicy.maxAttempts`, the message goes to that channel's DLQ
   instead of being retried again. An admin endpoint (see
   [`../roadmap.md`](../roadmap.md)) allows inspecting/replaying DLQ
   messages; replay is safe because it re-enters the same dedupe claim in
   step 3, not a raw re-send.

## Retry ladder — one consumer per channel, all tiers

Each channel worker (`worker-sms`, `worker-push`, `worker-email`,
`worker-inapp`) subscribes to its own `command.{channel}` topic **and**
all three of that channel's retry topics
(`command.{channel}.retry-30s/-5m/-30m`). A message on a retry topic is
held (delay-aware consume, not a busy poll) until its tier's backoff has
elapsed, then re-produced to `command.{channel}` for another attempt. This
is deliberately one process type per channel rather than one process per
tier: at this system's target scale a consumer idling out a wait window
isn't a real cost, and four retry-aware workers are simpler to deploy and
monitor than twelve single-tier ones. Revisit only if a load test shows a
specific tier's backlog starving the others.

## Fan-out — one event, many recipients

`services/fanout-expander` resolves a broadcast into individual
per-recipient events, in two stages:

1. Consumes `events.broadcast` (Door 2 only, one message per broadcast
   request, `audienceDescriptor` instead of a single `recipientId`).
   Resolves the descriptor and republishes work-sized chunks — capped at
   200 recipients per chunk, sized by *work* (each recipient can fan out to
   up to 4 channel commands) rather than raw recipient count — onto
   `events.broadcast.chunks`, keyed by `chunkId`.
2. Consumes `events.broadcast.chunks` and expands each chunk into
   individual per-recipient facts, republished onto
   `events.{critical|standard|bulk}` keyed by `recipientId` — the same
   shape either door produces normally, so the router treats a
   fanned-out recipient identically to any other event. Each expanded
   recipient gets its own `notificationRequestId`, tagged with a
   `broadcastId` back-reference for traceability.

See [ADR 0011](../adr/0011-scheduling-and-fanout.md).

## In-app is structurally different

SMS/Push/Email are fire-and-forget: dispatch calls an external provider and
records the result. In-app has no external provider — `InAppGateway` means
"deliver to a live WebSocket connection if the recipient has one, and
always write a `NotificationFeedItem` (see
[`data-model.md`](data-model.md)) so it's visible later regardless."

That splits into two components with different scaling axes, which used to
be welded into one `worker-inapp` process:

- **`worker-inapp`** consumes `command.in_app` and only writes the
  `NotificationFeedItem` projection — the read half, consumed by
  `GET /v1/feed/:recipientId`. It scales with dispatch volume, like the
  other channel workers.
- **`services/inapp-gateway`** is stateless and holds the WebSocket
  connection registry (which recipient is connected to which instance). It
  scales with concurrent connection count, which doesn't track dispatch
  volume — a recipient's socket lands on whichever node the load balancer
  picked, not whichever node owns their partition.

`worker-inapp` publishes over Redis pub/sub to notify `inapp-gateway` a
feed item was written; `inapp-gateway` pushes it to the recipient's socket
if one is open. Neither holds a Kafka consumer-group membership the other
depends on, so adding `inapp-gateway` replicas to absorb a connection surge
no longer triggers a dispatch-path rebalance. See
[ADR 0012](../adr/0012-inapp-gateway-split.md).

## Delivery status has one writer

`services/projection-notification` is the **single writer** of
`NotificationRequest.status`. It consumes both `events.*` (for the
`accepted` transition, published by the router) and `delivery-status` (for
`sent`/`delivered`/`failed`, published by channel workers), and applies an
ordered state machine — `accepted → sent → delivered`, never backwards —
rather than a plain upsert. This replaces the earlier design, where the
projection wrote `accepted` from one consumer group and workers wrote
`sent`/`delivered` from another with no ordering between them: Cassandra
resolves same-cell writes last-write-wins by timestamp, so a lagging
`accepted` write could land after a `delivered` write and regress the row.
"Idempotent upsert" guards against duplicates; it doesn't guard against
going backwards, and only the ordered state machine does. See
[ADR 0010](../adr/0010-delivery-reliability.md).

This projection is a read model only — nothing on the delivery path reads
from it or waits on it. `GET /v1/notifications/:id` is its only consumer.

## Message envelopes

**Event envelope** (`events.*`, `events.broadcast`, `events.broadcast.chunks`):
```json
{
  "eventId": "uuid",
  "tenantId": "uuid",
  "recipientId": "uuid (or audienceDescriptor for events.broadcast)",
  "notificationType": "string",
  "channel": "sms | push | email | in_app (optional override)",
  "templateVersionId": "uuid (optional)",
  "payloadRef": { "vars": { "...": "..." } },
  "priority": "critical | standard | bulk",
  "broadcastId": "uuid (optional, set on fan-out-expanded events)"
}
```
`payloadRef` carries template variable keys/values, not rendered content —
see [`data-privacy.md`](data-privacy.md) for why, and for how those values
are protected against a long-retention log.

**Command envelope** (`command.*`):
```json
{
  "notificationRequestId": "uuid",
  "tenantId": "uuid",
  "recipientId": "uuid",
  "channel": "sms",
  "renderedContent": "string or channel-specific structure",
  "attemptNumber": 1
}
```
Self-contained by design — see "Self-contained command payload" above.

**Delivery-status envelope** (`delivery-status`):
```json
{
  "notificationRequestId": "uuid",
  "status": "accepted | sent | delivered | failed",
  "attemptNumber": "int (absent for accepted)",
  "providerResponse": "string, nullable"
}
```

## Consumer guarantees

- Manual offset commit: an offset is only committed after the relevant
  write (dedupe claim + gateway call for workers; the ordered status write
  for the projection) durably completes, so a crash mid-processing results
  in redelivery (Kafka's at-least-once default), not silent loss.
- Dispatch is idempotent per attempt at the message-processing level
  (`notificationRequestId` + `attemptNumber`) and, more importantly, at the
  side-effect level via the dedupe claim above — redelivery after a
  provider call already succeeded is a safe no-op that never repeats the
  call.
- The status projection is idempotent *and* monotonic: redelivery is a
  safe no-op (idempotent), and out-of-order delivery across its two source
  topics can't regress the row (monotonic, via the state machine).

## What changed from ADR 0008

[ADR 0008](../adr/0008-notification-delivery-cqrs.md)'s core decision —
Kafka as the durable log of record, Cassandra/Postgres as an eventually
consistent read model, no dual write — is unchanged.
[ADR 0009](../adr/0009-event-backbone-router.md) changes two things on top
of it: the read-model projection is no longer anything a worker depends on
to do its job (it used to be), and there are now two write paths into the
backbone (Door 1, Door 2) upstream of a single router rather than one
ingest path upstream of independent workers.

## Future — audit and analytics sinks (deferred)

Not part of Phase 1 (see [`../roadmap.md`](../roadmap.md#future-work)):
independent audit and analytics consumer groups, reading `events.*` with
their own offsets, off the delivery path entirely — if either lags or
dies, sends are unaffected. Purely additive once built (a new consumer
reading the existing backbone), which is why it's safe to defer past
Phase 1 rather than build it now.

## What local dev proves vs. what it doesn't

A single-broker Kafka container (Docker Compose) with a handful of
partitions proves the pipeline is *correct* end-to-end — ordering, retry
tiers, idempotent production/consumption, dedupe-claim behavior. It does
not, by itself, demonstrate peak throughput; that's a property of
partition count and consumer-group size at real load, which is a
capacity/hosting decision, not a code change. See
[ADR 0002](../adr/0002-message-broker-kafka.md).
