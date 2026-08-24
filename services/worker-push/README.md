# services/worker-push

Consumes the `push.notify` queue and dispatches push notifications. A
**composition root**: wires the `domain-notification` dispatch service
(preference check → rate limit → send → persist attempt) to
`infra-postgres`, `infra-rabbitmq`, `infra-redis`, and `providers-push`, and
runs the retry/backoff/circuit-breaker loop around it. Structurally
identical to `services/worker-sms`, differing only in the gateway port it's
wired to.

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`MessageBroker`, `RateLimiter`, `PushGateway`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See queue topology and retry/DLQ design in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
