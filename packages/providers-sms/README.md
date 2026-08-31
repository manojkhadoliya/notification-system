# packages/providers-sms

Implements the `SmsGateway` port defined by `domain-notification`. Ships
two adapters, selected by the composition root's env config (this package
never reads `process.env` itself — same pattern as every other adapter):
- **`TwilioSmsGateway`** — real SMS delivery, calling Twilio's REST API
  directly over `fetch` (not the `twilio` SDK — one well-documented HTTP
  call isn't worth a dependency for). `fetchImpl` is a constructor seam
  so its request-building and status-classification logic is
  unit-tested against a stub, not a live account.
- **`MockSmsGateway`** — simulates success/failure/latency (configurable,
  with an injectable `random()` for deterministic tests), so the full
  pipeline (including retry/backoff/DLQ) is testable and demoable without
  a Twilio account or any cost.

Both interpret `ChannelCommand.renderedPayload` as `{ to, body }`
(`sms-payload.ts`) — `domain-notification` deliberately doesn't define
that shape (see `ChannelCommand`'s doc comment), so this package is where
the `sms` channel's payload contract gets written down. `services/router`
(not yet built) is expected to populate it when it resolves the
recipient's phone number and renders the template. A malformed payload is
treated as `retryable: false` (a router/template bug, not a transient send
failure) by both adapters, without ever reaching the provider call.

A `4xx` other than `429` (invalid number, unsubscribed recipient, bad
credentials, ...) is classified `retryable: false`; `429` and any `5xx`
are `retryable: true` (`isRetryableTwilioStatus`) — same "invalid input
vs. transient provider failure" split `GatewaySendResult.retryable`'s doc
comment describes.

Also owns `verifyTwilioSignature` — the `POST /v1/webhooks/twilio`
signature verification logic `services/api` uses to confirm a delivery
status callback actually came from Twilio before trusting it (see
[`api-spec.md`](../../docs/architecture/api-spec.md#post-v1webhookstwilio)).
Pure and unit-tested against self-generated fixtures (no live Twilio
account in this session to source an official test vector from).

Depends on `shared-kernel` and `domain-notification` (to implement its
port interface); never the reverse.

**Delivered in:** Phase 1.
