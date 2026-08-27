# services/worker-push

Consumes `command.push` and its retry tiers
(`command.push.retry-30s/-5m/-30m`) and dispatches push notifications. A
**composition root**: wires the `domain-notification` dispatch service
(dedupe claim → rate limit → send → persist attempt) to `infra-postgres`
(dedupe claims, delivery attempts, and — Phase 1 — the notification
read model), `infra-kafka`, `infra-redis`, and `providers-push`, and runs
the retry-tier/backoff/circuit-breaker loop itself — one process handling
all of this channel's tiers, not a separate process per tier (see
[ADR 0010](../../docs/adr/0010-delivery-reliability.md)). Structurally
identical to `services/worker-sms`, differing only in the gateway port
it's wired to.

The message this worker consumes already carries the fully rendered
payload, and preference/quiet-hours checks already happened upstream, in
`services/router` — see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md).

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`PushGateway`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See topic layout, dedupe claim, and retry topology in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
