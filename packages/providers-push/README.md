# packages/providers-push

Implements the `PushGateway` port defined by `domain-notification`. Ships
two adapters, selected by env config:
- **FCM adapter** — real push delivery via Firebase Cloud Messaging.
- **Mock adapter** — simulates success/failure/latency, so the full
  pipeline (including retry/backoff/DLQ) is testable and demoable without
  an FCM project or any cost.

Depends on `domain-notification` (to implement its port interface); never
the reverse.

**Delivered in:** Phase 1.
