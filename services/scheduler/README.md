# services/scheduler

Polls the `scheduled_notifications` table for due rows and re-emits them
onto the event backbone. A **composition root**: no business logic beyond
the claim/re-emit loop (`SchedulerService.pollOnce`) — `router-service.ts`
already builds the row (with jitter, see below) when it defers instead of
dropping or proceeding. Shards its claim query by `(due_minute, bucket)`
and relies on `due_at` being jittered at write time, both built in from
the start, not added after a thundering-herd incident, since a naive
single-bucket poller is a known failure mode at scale (e.g. every digest
recipient's row due inside the same minute, off one index). Claims rows
with `SELECT ... FOR UPDATE SKIP LOCKED` so multiple poller replicas can
run without claiming the same row twice.

A claimed row is re-emitted onto `events.{critical|standard|bulk}` and
re-enters the normal pipeline through `services/router`, exactly as if it
had just arrived — no special-cased "this came from the scheduler" path
anywhere downstream.

Unlike every channel worker/`services/router`, this process has **no
Kafka consumer-group membership at all** — it only ever produces. It
drives its own poll loop on a plain interval (`SCHEDULER_POLL_INTERVAL_MS`),
not a consumer callback; see `index.ts`'s doc comment for how that changes
its shutdown handling.

**Depends on (ports):** `ScheduledNotificationRepository`, `MessageBroker`.

## Two real gaps found and fixed while building this, not here

Building the *consuming* half of scheduling surfaced two correctness bugs
in the already-merged `ScheduledNotification`/`services/router` deferral
path — both fixed in this PR, not deferred, since shipping this poller on
top of them would have made both bugs live in practice for the first
time:

- **The original `notificationRequestId` was being dropped on defer.**
  `ScheduledNotification.schedule` minted a fresh row `id` but had no
  field for the *original* `NotificationEvent.notificationRequestId` the
  client was handed at `202 Accepted` time. A poller re-emitting under
  the row's own `id` would have made every quiet-hours-deferred request
  permanently unqueryable via `GET /v1/notifications/:id` — the
  `NotificationRequest` row `services/projection-notification` will
  eventually write would exist under an id the client never saw. Fixed
  by adding `notificationRequestId` as its own field, preserved end to
  end (`ScheduledNotification` → Postgres → `SchedulerService.emitOne`).
- **`broadcastId` was dropped the same way**, for a fanout-expanded
  recipient's event that gets deferred. Currently dormant (nothing
  produces a non-null `broadcastId` yet — `services/fanout-expander`
  isn't built), but the same class of bug, fixed the same way, so it
  doesn't need rediscovering when that service ships.

See `packages/domain-notification/src/scheduled-notification.ts`'s doc
comments and `docs/architecture/data-model.md`'s `ScheduledNotification`
table for the full writeup.

## Judgment calls worth knowing about

- **Jitter (up to 60s, forward-only) was added to `services/router`'s
  `defer()`**, not here — this package's own original README already
  claimed jitter was "built in from the start," but nothing actually
  computed one; that was aspirational documentation, not reality, until
  this PR. Added in `router-service.ts` (a `jitter: () => number`
  constructor seam, same pattern as its existing `now` seam) rather than
  in `domain-preferences`' `nextQuietHoursEnd` — a pure "when does the
  window end" calculation has no reason to know about poller-sharding
  concerns. 60s isn't a number [ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md)
  itself pins down — a judgment call, see `MAX_DEFER_JITTER_MS`'s doc
  comment.
- **A claimed-but-never-emitted row has no automated reclaim path.** If
  `publishEvent` (or the follow-up `save(markEmitted())`) fails for a
  claimed row, `pollOnce` logs it and moves on rather than blocking the
  rest of the batch — but `claimDue` only ever selects `status =
  'pending'` rows, so that row stays `"claimed"` forever with no built-in
  way back to `"pending"`. Unlike a `DedupeClaim` (where "already
  claimed" is *always* the correct terminal outcome), a stuck scheduler
  claim is a real, silent loss — the notification it represents simply
  never gets sent. A real fix needs a "claimed longer than N minutes ago"
  reclaim query in `ScheduledNotificationRepository`; not built here —
  Phase 1 has no operational tooling to notice a stuck row exists, either.
- **Sharding config is per-instance env vars (`SCHEDULER_BUCKET`,
  `SCHEDULER_BUCKET_COUNT`), not service discovery.** Running N replicas
  means giving each a distinct `SCHEDULER_BUCKET` over the same
  `SCHEDULER_BUCKET_COUNT` by hand (e.g. via distinct container env in
  compose/k8s) — there's no coordinator assigning shards dynamically, the
  same manual-sharding model Kafka's own consumer groups would otherwise
  give for free if this process had one.

## Testing

`SchedulerService.pollOnce` is fully unit-tested (14 tests, including
`config.ts`) against `test-support.ts`'s fakes — unlike
`services/router`'s own `FakeScheduledNotificationRepository` (which
stubs `claimDue` to `[]`, since routing never calls it), this package's
fake implements `claimDue` for real: status filtering, the `(dueMinute,
bucket)` shard predicate, and the claim limit, so the sharding logic
itself is exercised without a live Postgres.

**Not yet verified against live Postgres/Kafka** — no Docker in the
session this was built in. `scripts/smoke-test.mjs` seeds a due row
directly via Prisma and asserts the resulting `events.standard` message
and the row's `emitted` status; see that script's header comment for the
run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/scheduler build
pnpm --filter @notification-system/scheduler start     # reads .env — see .env.example
pnpm --filter @notification-system/scheduler smoke-test
```

`SCHEDULER_BUCKET`/`SCHEDULER_BUCKET_COUNT` default to `0`/`1` (a single
instance claiming everything); `SCHEDULER_CLAIM_LIMIT` defaults to `100`;
`SCHEDULER_POLL_INTERVAL_MS` defaults to `5000`.

**Delivered in:** Phase 1. Design and rationale in
[ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md).
