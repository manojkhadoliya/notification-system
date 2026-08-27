# services/scheduler

Polls the `scheduled_notifications` table for due rows and re-emits them
onto the event backbone. A **composition root**: no business logic beyond
the claim/re-emit loop. Shards its claim query by `(due_minute, bucket)`
and relies on `due_at` being jittered at write time (by `services/router`,
when it defers a message) — both built in from the start, not added after
a thundering-herd incident, since a naive single-bucket poller is a known
failure mode at scale (e.g. every digest recipient's row due inside the
same minute, off one index). Claims rows with `SELECT ... FOR UPDATE SKIP
LOCKED` so multiple poller replicas can run without claiming the same row
twice.

A claimed row is re-emitted onto `events.{critical|standard|bulk}` and
re-enters the normal pipeline through `services/router`, exactly as if it
had just arrived — no special-cased "this came from the scheduler" path
anywhere downstream.

**Depends on (ports):** `ScheduledNotificationRepository`, `MessageBroker`.

**Delivered in:** Phase 1. Design and rationale in
[ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md).
