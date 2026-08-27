# services/projection-notification

The **single writer** of `NotificationRequest.status` — consumes
`events.critical`/`events.standard`/`events.bulk` (for the `accepted`
transition, published by `services/router`) and `delivery-status` (for
`sent`/`delivered`/`failed`, published by the channel workers), and
applies an ordered state machine (`accepted → sent → delivered`, never
backwards) rather than a plain upsert. A **composition root**: no business
logic beyond that state machine.

This is the "C" side of the CQRS split described in
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md), amended by
[ADR 0009](../../docs/adr/0009-event-backbone-router.md) and
[ADR 0010](../../docs/adr/0010-delivery-reliability.md): it's what makes
an accepted request visible to `GET /v1/notifications/:id` at all, but
nothing on the delivery path reads from it or waits on it — it's a read
model only. It runs independently of `services/router` and the channel
workers (separate consumer group on both source topics) so read-model
projection scales independently of dispatch. Having exactly one consumer
group own every write to `status` — rather than `services/router` and the
workers each writing their own part — is what prevents the row from
regressing under a lagging consumer (see
[ADR 0010](../../docs/adr/0010-delivery-reliability.md#single-writer-status)).

**Depends on (ports):** `NotificationRepository`, `MessageBroker`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See [`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)
for the consumer-group layout.
