# services/worker-push

Consumes the `push.notify` topic and dispatches push notifications. A
**composition root**: wires the `domain-notification` dispatch service
(preference check → rate limit → send → persist attempt) to
`infra-cassandra`, `infra-postgres` (preferences), `infra-kafka`,
`infra-redis`, and `providers-push`, and runs the retry-topic/backoff/
circuit-breaker loop around it (see
[ADR 0008](../../docs/adr/0008-elastic-scale-data-plane.md)). Structurally
identical to `services/worker-sms`, differing only in the gateway port it's
wired to.

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`MessageBroker`, `RateLimiter`, `PushGateway`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See queue topology and retry/DLQ design in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
