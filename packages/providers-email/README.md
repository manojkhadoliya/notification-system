# packages/providers-email

Implements the `EmailGateway` port defined by `domain-notification`.

- **`MockEmailGateway`** — simulates success/failure/latency (configurable,
  with an injectable `random()` for deterministic tests), so the full
  pipeline (including retry/backoff/DLQ) is testable and demoable without
  any provider account or cost.

This is currently the **only** adapter in this package. The docs left the
real provider undecided (`SES/SendGrid`, unlike `providers-sms`/
`providers-push`, which already committed to Twilio/FCM), and building a
real one turned out to be a real fork: SES needs AWS SigV4 request
signing (either hand-rolled — notably more involved than Twilio/FCM's
schemes — or the AWS SDK, which breaks this repo's "no heavy SDK
dependency for one well-documented HTTP call" pattern), while SendGrid is
a simple Bearer-token REST API in the same shape as the other two
providers. Rather than pick without a real need driving the choice, a real
`EmailGateway` adapter is deliberately deferred — build one (most likely
SendGrid, for consistency with the rest of this package's siblings) when
there's an actual reason to send real email.

`MockEmailGateway` interprets `ChannelCommand.renderedPayload` as
`{ to, subject, body }` (`email-payload.ts`) — `domain-notification`
deliberately doesn't define that shape (see `ChannelCommand`'s doc
comment: "a subject+body shape for email"), so this package is where the
`email` channel's payload contract gets written down, same call
`providers-sms`/`providers-push` made for their channels.
`services/router` (not yet built) is expected to populate `to` with the
recipient's email address. A malformed payload is `retryable: false`
(a router/template bug, not a transient send failure).

Depends on `shared-kernel` and `domain-notification` (to implement its
port interface); never the reverse.

**Delivered in:** Phase 1, built together with the other three channels
(see [ADR 0004](../../docs/adr/0004-channel-rollout.md)). Used by
`services/worker-email`.
