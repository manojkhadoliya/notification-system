# packages/providers-push

Implements the `PushGateway` port defined by `domain-notification`. Ships
two adapters, selected by the composition root's env config (this package
never reads `process.env` itself — same pattern as every other adapter):
- **`FcmPushGateway`** — real push delivery via Firebase Cloud Messaging's
  HTTP v1 API, called directly over `fetch` (not `firebase-admin`/
  `google-auth-library` — one well-documented OAuth2 service-account flow
  isn't worth a dependency for, same call `providers-sms` made for
  Twilio). `fcm-auth.ts` builds and signs the JWT assertion by hand with
  `node:crypto`; the resulting access token is cached in-memory and
  reused until shortly before it expires. `fetchImpl`/`now` are
  constructor seams so request-building, token caching, and error
  classification are unit-tested against a stub, not a live Firebase
  project.
- **`MockPushGateway`** — simulates success/failure/latency (configurable,
  with an injectable `random()` for deterministic tests), so the full
  pipeline (including retry/backoff/DLQ) is testable and demoable without
  an FCM project or any cost.

Both interpret `ChannelCommand.renderedPayload` as
`{ token, title, body, data? }` (`push-payload.ts`) — `domain-notification`
deliberately doesn't define that shape (see `ChannelCommand`'s doc
comment), so this package is where the `push` channel's payload contract
gets written down, same call `providers-sms` made for `sms`.
`services/router` (not yet built) is expected to populate `token` with the
recipient's FCM registration token. A malformed payload — including a
non-string `data` value, since FCM's `data` payload is string-valued only
— is treated as `retryable: false` by both adapters, without ever
reaching the provider call.

FCM HTTP v1's documented `error.status` values classify cleanly:
`UNAVAILABLE`/`INTERNAL`/`QUOTA_EXCEEDED` are `retryable: true`;
`INVALID_ARGUMENT`/`UNREGISTERED`/`SENDER_ID_MISMATCH`/
`THIRD_PARTY_AUTH_ERROR` are `retryable: false` (`isRetryableFcmError`,
falling back to the HTTP status code for anything else).

Depends on `shared-kernel` and `domain-notification` (to implement its
port interface); never the reverse.

**Delivered in:** Phase 1.
