# services/router

The single decision point in the system — consumes
`events.critical`/`events.standard`/`events.bulk` and, for each event:
resolves the recipient + preferences, applies the quiet-hours check
(deferring into `ScheduledNotification` rather than dropping), resolves
the channel (honoring an explicit override as a request, still checked
against opt-out), renders the template, and publishes a fully rendered,
self-contained command to `command.{channel}` plus an `accepted` outcome
to `delivery-status`. A **composition root**: decision logic lives in
this package's own pure functions (`routing.ts`, `render-template.ts`,
`build-channel-payload.ts`); `router-service.ts` is only the I/O
sequencing.

**Depends on (ports):** `PreferenceRepository`, `TemplateRepository`,
`ScheduledNotificationRepository`, `MessageBroker`.

## Judgment calls worth knowing about

Several of these exist because `messaging.md#router`'s five steps
describe *what* the router decides without pinning down every detail —
each is a real, deliberate call, not an oversight:

- **No `Preference` row for a channel is treated as opted in.** "Opt-out"
  terminology (and `PUT /v1/preferences` existing only to *change*
  state) implies that's the default, not a required explicit opt-in.
- **Auto-pick order, when no channel is requested, is `shared-kernel`'s
  `CHANNELS` declaration order** (`sms`, `push`, `email`, `in_app`) — not
  specified anywhere else. One consequence: `Recipient.hasAddressFor` is
  unconditionally `true` for `in_app`, so an auto-picked route only ever
  suppresses (`opted-out`) if *every* channel including `in_app` is
  opted out — `no-address-for-channel` is only reachable via an
  *explicit* channel request. See `routing.ts`'s doc comment.
- **A missing `Recipient` row is treated as `suppressed`/
  `no-address-for-channel`** — the closest fit among
  `RoutingDecision`'s two suppression reasons.
- **No `templateVersionId` means `payloadRef.message` is used as the
  body directly** — matches `api-spec.md`'s own example body
  (`{"payload": {"message": "string"}}`) for the "raw content, no
  template" case. Falls back to `JSON.stringify(payloadRef)` if
  `.message` isn't a string.
- **Push's `title` and email's `subject` default to the raw
  `notificationType` string.** `TemplateVersion.content` is one
  Handlebars source producing one rendered body — there's no field yet
  for a channel that needs a second, shorter piece of text. A real fix
  is a `TemplateVersion` schema change (a `domain-templates`/
  `infra-postgres` decision), not something to improvise here — see
  `build-channel-payload.ts`.
- **A suppressed request publishes nothing** — no command, no
  `delivery-status` event. Consistent with messaging.md's "nothing is
  dropped and nothing loops through the retry ladder for a suppression
  that was never a failure," but worth knowing explicitly: right now a
  suppressed `notificationRequestId` leaves no trace anywhere
  `GET /v1/notifications/:id` could ever surface. Revisit if there's a
  concrete need to tell a tenant *why* a recipient wasn't notified.
- **A deferred `dueAt` gets up to 60s of forward-only jitter** (never
  subtracted — a deferred send never fires before its computed time),
  added here rather than in `domain-preferences`' `nextQuietHoursEnd`
  (a pure "when does the window end" calculation with no reason to know
  about poller-sharding concerns). Per
  [ADR 0011](../../docs/adr/0011-scheduling-and-fanout.md): many
  recipients sharing one quiet-hours policy's exact end minute would
  otherwise all land on the same `due_minute`, which
  `services/scheduler`'s `(due_minute, bucket)` sharding can't spread
  out on its own. 60s isn't a number the ADR pins down — a judgment
  call, see `MAX_DEFER_JITTER_MS`'s doc comment in `router-service.ts`.
- **Quiet hours are evaluated against UTC, not the recipient's local
  time.** `domain-preferences`' own `quiet-hours.ts` doc comment says
  "the router resolves a recipient's timezone and passes an
  already-localized now in" — but nothing in the domain model stores a
  recipient's timezone (`Recipient` has no such field, `Preference` has
  none either). This is a real, known limitation, not a silent
  assumption: quiet hours as currently enforced apply uniformly in UTC
  regardless of where a recipient actually is. Fixing it needs a
  `Recipient.timezone` field (and a decision about what sets it, since
  there's no API surface for it yet) before the router can do better.

## Deliberately not built here

- **The Redis read-through cache** `scaling-strategy.md#keeping-postgres-off-the-hot-path`
  describes for `PreferenceRepository` (and `ApiKeyRepository`) — a
  performance optimization needed at ~1,000 dispatches/sec, not for
  correctness. This pass calls the uncached `infra-postgres` adapters
  directly. Per that doc, caching belongs *inside* the existing adapter
  (transparent to this package's `PreferenceRepository` usage), so
  adding it later is a self-contained `infra-postgres`/`infra-redis`
  change, not a router change.
- **Template auto-resolution by `notificationType` + `channel`**
  (mentioned in `messaging.md#router` as an alternative to an explicit
  `templateVersionId`) — no port maps `notificationType` to a `Template`,
  and `TemplateVersion` is locale-scoped with no locale carried anywhere
  in the event pipeline (`NotificationEvent` has no `locale` field).
  Only explicit `templateVersionId` rendering is supported; see the
  "no `templateVersionId`" judgment call above for what happens without
  one.

## Testing

`routing.ts`'s `decideChannel` is a pure function (no I/O) — every branch
(explicit vs. auto-pick, opt-out, no-address, quiet-hours defer,
critical-priority override, cross-candidate earliest-deferral) is
directly unit-tested, no fakes needed. `render-template.ts` and
`build-channel-payload.ts` are pure too. `router-service.ts`'s I/O
sequencing is tested against the in-memory fakes in `test-support.ts`
(same approach `services/api`'s route tests and `DispatchService`'s own
suite use) — verifying what gets published/scheduled and, just as
importantly, what does *not* (a suppressed or deferred event must
publish nothing).

**Not yet verified against live Postgres/Kafka** — no Docker in the
session this was built in. `scripts/smoke-test.mjs` seeds a `Recipient`
via Prisma, publishes a real event, and asserts the resulting
`command.sms` + `delivery-status` messages arrive; see that script's
header comment for the run steps.

## Local setup

```
pnpm compose:up
pnpm kafka:topics
pnpm --filter @notification-system/router build
pnpm --filter @notification-system/router start     # reads .env — see .env.example
pnpm --filter @notification-system/router smoke-test
```

**Delivered in:** Phase 1 — the single largest structural item in this
phase (see [`../../docs/roadmap.md`](../../docs/roadmap.md)). Full
responsibilities in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#router).
