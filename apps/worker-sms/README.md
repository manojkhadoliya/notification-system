# apps/worker-sms

Consumes the `sms.notify` queue and dispatches SMS notifications. A
**composition root**: wires the `domain-notification` dispatch service
(preference check → rate limit → send → persist attempt) to
`infra-postgres`, `infra-rabbitmq`, `infra-redis`, and `providers-sms`, and
runs the retry/backoff/circuit-breaker loop around it.

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`MessageBroker`, `RateLimiter`, `SmsGateway`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See queue topology and retry/DLQ design in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
