# packages/providers-email

Implements the `EmailGateway` port defined by `domain-notification`: a real
SES/SendGrid adapter and a `mock` adapter, env-toggled so the whole system
runs and is testable without any provider account (same pattern as
`providers-sms`/`providers-push`).

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-phased-channel-rollout.md)). Used by
`services/worker-email`.
