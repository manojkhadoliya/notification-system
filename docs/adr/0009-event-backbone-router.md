# ADR 0009: Event backbone + router — dual ingress, decide before dispatch

## Status
In Progress

## Context
The original design had one ingress (`POST /v1/notifications`) producing
directly to a per-channel `<channel>.notify` topic, with the caller naming
the channel and each worker independently checking preferences after the
message was already committed and (per [ADR 0008](0008-notification-delivery-cqrs.md))
independently projected by a separate consumer group. Two problems follow
directly from that shape:

- **No centralized decision point.** An opted-out recipient's message is
  authenticated, rate-limited, produced, keyed, and projected — and only
  then dropped, by the worker. Quiet hours has nothing to defer to: there's
  no scheduler, no `due_at`, no mechanism, so in practice it can only
  become a silent drop or a retry-ladder trip into the DLQ.
- **No internal ingress.** Every trigger for a notification — a payment
  failed, an assignment was graded — has to go through the same
  tenant-facing HTTP contract as an external API caller, even when the
  caller is a first-party service inside the same system that just wants
  to say "this happened."

Both point at the same missing piece: something has to decide, once,
before a message reaches a channel topic, whether and how to send it —
and that decision point needs to be reachable from more than one kind of
caller.

## Decision
Insert a router between ingress and the channel topics, and give it two
ingress doors that both normalize onto the same event shape before the
router sees anything:

- **Door 1** — `POST /v1/notifications` (unchanged surface, revised body —
  see [`api-spec.md`](../architecture/api-spec.md)): tenant-authenticated,
  one `recipientId` per call, states a `notificationType` and optionally an
  explicit channel/template override. No audience descriptor — see
  "Broadcast is Door 2 only" in [`messaging.md`](../architecture/messaging.md).
- **Door 2** — an internal producer library (no HTTP hop), importing the
  same `MessageBroker` port Door 1 uses, for a first-party service to
  publish a domain fact directly.

Both produce to `events.{critical|standard|bulk}`, keyed by `recipientId`.
`services/router` is the only consumer that decides anything: it resolves
tenant + preferences, applies quiet hours (deferring into
`ScheduledNotification` rather than dropping — see
[ADR 0011](0011-scheduling-and-fanout.md)), resolves the channel (honoring
an explicit override as a *request*, still checked against opt-out), and
renders the template. It publishes the result — fully rendered, not a
reference — to `command.{channel}`, which is what workers actually
consume. Full topology and message shapes:
[`messaging.md`](../architecture/messaging.md).

## Rationale
- **One decision, one place, before commit.** Every capability this ADR
  adds (centralized channel choice, quiet-hours deferral, channel fallback
  as a future extension point) requires a component that sees the request
  before it's irreversibly on a channel topic. Putting it in the router
  once is cheaper to build, test, and reason about than putting equivalent
  logic in every worker.
- **Self-contained command payload removes a race, not just an
  inefficiency.** The previous design's worker read the request payload
  back from the read-model projection — a separate consumer group with no
  ordering guarantee against the worker. That's not a rare edge case; it's
  the default relationship between two independent consumer groups under
  load, and it's self-amplifying (more misses → more retries → more load
  on the same two lagging components). Rendering once, in the router, and
  publishing the result eliminates the dependency. A command's lifetime is
  seconds; keeping it self-contained isn't "a second source of truth," it's
  an instruction.
- **Two doors, one backbone, keeps both products real.** An external
  tenant calling with "notify this recipient" and an internal service
  emitting "this happened, decide who hears about it" are both real,
  common shapes — forcing either into the other's contract is the wrong
  fit for one of them. Normalizing before the router means nothing
  downstream needs to know which door a message came through.

## Alternatives considered
- **Keep channel selection at the client, add quiet-hours/preference
  checks earlier in the worker itself.** Doesn't solve the "opted-out
  message does full work before being dropped" problem, and still leaves
  every worker independently reimplementing the same decision — the router
  centralizes logic that would otherwise be duplicated four times and
  drift.
- **One ingress door only (HTTP), with an internal client library that
  calls the HTTP API.** Adds a network hop and a serialization round-trip
  for a caller inside the same system, for no consistency benefit — the
  event shape is what needs to be shared, not the transport.

## Consequences
- `services/router` is a new composition root — see
  [`overview.md`](../architecture/overview.md).
- [ADR 0008](0008-notification-delivery-cqrs.md) is amended, not reversed:
  Kafka is still the log of record and there's still no dual write; what
  changes is that nothing on the delivery path depends on the read-model
  projection anymore.
- `domain-notification` gains `RoutingDecision` as a concept and
  `DedupeRepository`/`ScheduledNotificationRepository` as new ports — see
  [`domain-model.md`](../architecture/domain-model.md).
- Topic layout changes from per-channel `<channel>.notify` to a two-layer
  `events.*` (pre-router) / `command.*` (post-router) split — see
  [`messaging.md`](../architecture/messaging.md#topic-layout).
