# services/worker-sms

Consumes the `sms.notify` topic and dispatches SMS notifications. A
**composition root**: wires the `domain-notification` dispatch service
(preference check → rate limit → send → persist attempt) to
`infra-cassandra`, `infra-postgres` (preferences), `infra-kafka`,
`infra-redis`, and `providers-sms`, and runs the retry-topic/backoff/
circuit-breaker loop around it (see
[ADR 0002](../../docs/adr/0002-message-broker-kafka.md)).

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`MessageBroker`, `RateLimiter`, `SmsGateway`.

**Delivered in:** Phase 1 (see [`../../docs/roadmap.md`](../../docs/roadmap.md)).
See queue topology and retry/DLQ design in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md).
