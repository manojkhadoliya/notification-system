# services/worker-sms

Consumes `command.sms` and its retry tiers
(`command.sms.retry-30s/-5m/-30m`) and dispatches SMS notifications. A
**composition root**: wires the `domain-notification` dispatch service
(dedupe claim → rate limit → send → persist attempt) to `infra-postgres`
(dedupe claims, delivery attempts, and — Phase 1 — the notification
read model), `infra-kafka`, `infra-redis`, and `providers-sms`, and runs
the retry-tier/backoff/circuit-breaker loop itself — one process handling
all of this channel's tiers, not a separate process per tier (see
[ADR 0010](../../docs/adr/0010-delivery-reliability.md)).

Unlike the pre-router design, the message this worker consumes already
carries the fully rendered payload — no read-back from a read model, no
race with a projection consumer (see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md)). Preference and
quiet-hours checks already happened upstream, in `services/router` — this
worker's only decisions are the dedupe claim and the retry/backoff
schedule.

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`SmsGateway`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See topic layout, dedupe claim, and retry topology in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
