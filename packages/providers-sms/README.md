# packages/providers-sms

Implements the `SmsGateway` port defined by `domain-notification`. Ships
two adapters, selected by env config:
- **Twilio adapter** — real SMS delivery.
- **Mock adapter** — simulates success/failure/latency, so the full
  pipeline (including retry/backoff/DLQ) is testable and demoable without
  a Twilio account or any cost.

Also owns the `POST /v1/webhooks/twilio` signature verification logic used
by `services/api` to confirm delivery status callbacks.

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** Phase 1.
