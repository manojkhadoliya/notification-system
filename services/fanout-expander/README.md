# services/fanout-expander

Resolves a broadcast into individual per-recipient events, in two stages.
A **composition root**: no business logic beyond descriptor resolution and
chunking.

1. Consumes `events.broadcast` (Door 2 only — internal services, not the
   tenant-facing API; see
   [`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#broadcast-is-door-2-only)),
   one message per broadcast request carrying an `audienceDescriptor`
   instead of a single `recipientId`. Resolves the descriptor and
   republishes work-sized chunks — capped at 200 recipients, sized by
   *work* rather than raw recipient count, since each recipient can fan
   out to up to 4 channel commands — onto `events.broadcast.chunks`, keyed
   by `chunkId`.
2. Consumes `events.broadcast.chunks` and expands each chunk into
   individual per-recipient events, republished onto
   `events.{critical|standard|bulk}` keyed by `recipientId`. Each expanded
   recipient gets its own `notificationRequestId` and a `broadcastId`
   back-reference.

A fanned-out recipient re-enters the normal pipeline through
`services/router` exactly like any other event — no special case for
"this one came from a broadcast" exists downstream of this service.

**Depends on (ports):** `MessageBroker`.

**Delivered in:** Phase 1. Design and rationale in
[ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md).
