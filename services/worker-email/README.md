# services/worker-email

Consumes the `email.notify` topic and dispatches email notifications. A
**composition root**: wires the `domain-notification` dispatch service
(preference check → rate limit → render template (if `templateVersionId`
set) via `domain-templates` → send → persist attempt) to `infra-cassandra`,
`infra-postgres` (preferences + templates), `infra-kafka`, `infra-redis`,
and `providers-email`, and runs the retry-topic/backoff/circuit-breaker loop
around it (see [ADR 0008](../../docs/adr/0008-elastic-scale-data-plane.md)).
Structurally identical to `services/worker-sms`/`services/worker-push`,
differing only in the gateway port it's wired to and the optional
template-rendering step.

**Depends on (ports):** `NotificationRepository`, `PreferenceRepository`,
`TemplateRepository`, `MessageBroker`, `RateLimiter`, `EmailGateway`.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-phased-channel-rollout.md)). See
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md)
for topic/retry topology.
