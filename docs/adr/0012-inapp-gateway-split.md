# ADR 0012: In-app gateway split — stateless socket registry vs. feed writer

## Status
In Progress

## Context
`worker-inapp` originally did two things a fire-and-forget channel worker
doesn't: hold the WebSocket connection registry (which recipient is
connected to which instance) and write the `NotificationFeedItem`
projection. Those don't share a scaling axis — a recipient's socket lands
on whichever node the load balancer picked; their messages land on
whichever node owns their partition, usually a different one — and the
original design never specified how a consuming node reaches a socket held
by a different one. Operationally, adding replicas to absorb a connection
surge triggers a Kafka consumer-group rebalance and interrupts in-flight
dispatch, coupling connection count to delivery throughput even though
neither should depend on the other.

## Decision
Split into two processes:

- **`worker-inapp`** consumes `command.in_app` (+ its retry tiers, per
  [ADR 0010](0010-delivery-reliability.md)), claims the dedupe key, and
  writes only the `NotificationFeedItem` projection. It scales with
  dispatch volume, the same as `worker-sms`/`worker-push`/`worker-email`.
- **`services/inapp-gateway`** is stateless and holds the WebSocket
  connection registry. It scales with concurrent connection count. It has
  no Kafka consumer-group membership.

`worker-inapp` publishes over Redis pub/sub after writing a feed row;
`inapp-gateway` subscribes and pushes to the recipient's socket if one is
open.

## Rationale
- **Different load shape, different scaling lever.** Connection count and
  dispatch throughput are two independent numbers in production — a
  marketing push that spikes dispatch volume doesn't necessarily spike
  concurrent connections, and a traffic surge that opens many sockets
  (e.g. a mobile app cold-start wave) doesn't necessarily spike dispatch.
  Coupling them into one process's scaling behavior means scaling for
  either problem costs the other.
- **Removing Kafka membership from the socket-holding process removes the
  rebalance interruption.** `inapp-gateway` replicas can be added or
  removed freely without touching any consumer group, so a connection
  surge no longer risks interrupting in-flight dispatch on
  `worker-inapp`.
- **Redis pub/sub, not a shared registry table.** A registry lookup
  ("which node holds this recipient's socket") only matters to whichever
  `inapp-gateway` instance is asked to push to it; pub/sub lets any
  `worker-inapp` instance announce a feed write without needing to know
  which gateway instance (if any) holds the relevant socket.

## Alternatives considered
- **Keep one process, add a shared connection registry (e.g. in Redis)
  that any worker instance can query.** Solves the "which node holds this
  socket" problem without a full split, but doesn't solve the coupled
  scaling/rebalance problem — the process is still both a Kafka consumer
  and a socket holder, so a connection surge still forces a rebalance.
- **Move socket holding to the API service (`services/api`) instead of a
  new process.** Keeps process count down, but couples WebSocket
  connection handling to the HTTP request/response service, which has a
  different deployment and scaling profile (stateless request handling)
  than a long-lived connection holder.

## Consequences
- New composition root: `services/inapp-gateway`.
- `worker-inapp`'s responsibility narrows to: consume, dedupe-claim, write
  `NotificationFeedItem`, publish to Redis. It no longer holds any
  connection state.
- `infra-redis` gains a pub/sub port used only by this pair, in addition
  to `RateLimiter`/`IdempotencyStore`.
