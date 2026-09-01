# services/projection-notification

The **single writer** of `NotificationRequest.status` — see
[ADR 0010](../../docs/adr/0010-delivery-reliability.md#single-writer-status).
A **composition root**: no business logic beyond the state machine
`NotificationRequest.advanceStatus` already enforces — this service is
only I/O sequencing (parse, look up, apply, save).

This is the "C" side of the CQRS split described in
[ADR 0008](../../docs/adr/0008-notification-delivery-cqrs.md), amended by
[ADR 0009](../../docs/adr/0009-event-backbone-router.md) and ADR 0010: it's
what makes an accepted request visible to `GET /v1/notifications/:id` at
all, but nothing on the delivery path reads from it or waits on it — it's
a read model only. It runs independently of `services/router` and the
channel workers (its own consumer group) so read-model projection scales
independently of dispatch.

**Depends on (ports):** `NotificationRepository`. (Not `MessageBroker` —
this service never publishes anything.)

## Consumes exactly one topic, not two

Docs elsewhere in this repo (this package's own earlier README included)
described this as consuming `events.*` "for the `accepted` transition"
and `delivery-status` "for `sent`/`delivered`/`failed`". That's not how
`services/router` actually publishes it — `RouterService.dispatch()`
publishes `"accepted"` onto `delivery-status`, the exact same topic and
`DeliveryStatusEvent` shape as every other transition, keyed by
`notificationRequestId` the same way. **This service consumes only
`delivery-status`.** That's not a simplification, it's the more correct
design: Kafka only guarantees ordering *within one partition of one
topic*, so having every transition for one `notificationRequestId` share
one topic and one key is what actually gives ADR 0010's "single writer,
ordered state machine" claim a real ordering guarantee to stand on — two
source topics would need `services/router` and every channel worker to
agree on `notificationRequestId`-consistent partitioning across topics
just to approximate what one topic already gives for free. Fixed in the
same PR that built this service (see `docs/architecture/messaging.md`'s
"Delivery status has one writer" section, corrected there too).

## The gap this surfaced (fixed here, not deferred)

`NotificationRequest.accept()` needs `channel` (the *resolved* channel —
never null, unlike `NotificationEvent.channel`) plus `tenantId`,
`recipientId`, `notificationType`, `idempotencyKey`, `broadcastId`, and
the *rendered* `payload` to construct a row at all. None of that lived on
the old 4-field `DeliveryStatusEvent` (`notificationRequestId`, `status`,
`attemptNumber`, `occurredAt`) — there was no way for this service to
have ever been buildable against it. Fixed by turning
`DeliveryStatusEvent` into a discriminated union: the `"accepted"` variant
carries everything `NotificationRequest.accept()` needs (the router is
the one place all of it is known at once, right when it publishes this
fact); `"sent"`/`"delivered"`/`"failed"` stay exactly as minimal as
before, since they only ever *advance* a row that must already exist.

Threading `idempotencyKey` through also surfaced a second, smaller gap:
nothing carried Door 1's `Idempotency-Key` header past ingest before this
— `NotificationEvent` had no field for it at all. Added
`NotificationEvent.idempotencyKey: string | null` (`null` for anything
Door 2 originated — internal services, and
`services/fanout-expander`-expanded broadcast recipients, have no
`Idempotency-Key` concept), threaded through
`ScheduledNotification`/`services/scheduler`'s re-emission path too (the
same class of "preserve across a defer/re-emit hop" fix already applied
to `notificationRequestId`/`broadcastId` there).

## Idempotency and ordering, concretely

- **A redelivered `"accepted"`** (Kafka at-least-once) is a no-op if the
  row already exists — re-creating or overwriting it would regress a row
  already advanced further, exactly the bug ADR 0010 fixed.
- **`"sent"`/`"delivered"`/`"failed"` with no existing row** — shouldn't
  happen given same-topic, same-key ordering (see above), but handled
  defensively rather than assumed impossible: logged and skipped, not
  thrown. This consumer must not crash-loop on a data anomaly it can't
  fix by retrying the same message.
- **An out-of-order or regressive transition against an existing row**
  (a redelivered `"sent"` arriving after `"delivered"` already landed,
  say) — `NotificationRequest.advanceStatus` returns `null` for it, and
  `ProjectionService` discards it rather than applying it. Already
  unit-tested at the entity level (`domain-notification`); re-verified
  here at the service level too.

## Testing

`ProjectionService` is fully unit-tested (11 tests, including `config.ts`)
against `test-support.ts`'s in-memory `FakeNotificationRepository` —
covering row creation, redelivery idempotency, the full
`accepted -> sent -> delivered` chain, the defensive
no-existing-row-for-an-advance case, and regressive-transition discarding.

**Not yet run against live Postgres/Kafka** — no Docker in the session
this was built in. `scripts/smoke-test.mjs` publishes a real
`accepted -> sent -> delivered` sequence and polls Postgres for the row
to reach each status in order; see that script's header comment for the
run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/projection-notification build
pnpm --filter @notification-system/projection-notification start     # reads .env — see .env.example
pnpm --filter @notification-system/projection-notification smoke-test
```

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See [`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)
for the consumer-group layout.
