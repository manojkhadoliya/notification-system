# services/worker-email

Consumes `command.email` and its retry tiers
(`command.email.retry-30s/-5m/-30m`) and dispatches email notifications. A
**composition root**: wires the `domain-notification` dispatch service
(dedupe claim → rate limit → send → persist attempt) to `infra-postgres`
(dedupe claims, delivery attempts, and — Phase 1 — the notification
read model), `infra-kafka`, `infra-redis`, and `providers-email`, and runs
the retry-tier/backoff/circuit-breaker loop itself — one process handling
all of this channel's tiers, not a separate process per tier (see
[ADR 0010](../../docs/adr/0010-delivery-reliability.md)). Structurally
identical to `services/worker-sms`/`services/worker-push`, differing only
in the gateway port it's wired to.

Template rendering no longer happens here — the command message this
worker consumes already carries the fully rendered content, rendered once
by `services/router` before publish (see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md)).

**Depends on (ports):** `DedupeRepository`, `MessageBroker`, `RateLimiter`,
`EmailGateway`.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-channel-rollout.md)). See
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)
for topic/retry topology.
