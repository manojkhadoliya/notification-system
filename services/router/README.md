# services/router

The single decision point in the system — consumes
`events.critical`/`events.standard`/`events.bulk` and, for each event:
resolves tenant + recipient preferences, applies the quiet-hours check
(deferring into `ScheduledNotification` rather than dropping), resolves
the channel (honoring an explicit override as a request, still checked
against opt-out), renders the template, and publishes a fully rendered,
self-contained command to `command.{channel}`. A **composition root**: the
decisions themselves are domain logic in `domain-notification`/
`domain-preferences`/`domain-templates`; this process wires those contexts
to `infra-postgres`, `infra-kafka`, and `infra-redis` (read-through cache)
and runs them per event.

This replaces the pre-router design, where the caller named the channel
and each worker independently re-checked preferences *after* the message
was already committed to a channel topic — see
[ADR 0009](../../docs/adr/0009-event-backbone-router.md) for why that
shape had no centralized decision point and no way to honor quiet hours at
all.

**Depends on (ports):** `PreferenceRepository`, `TemplateRepository`,
`ScheduledNotificationRepository`, `MessageBroker`.

**Delivered in:** Phase 1 — the single largest structural item in this
phase (see [`../../docs/roadmap.md`](../../docs/roadmap.md)). Full
responsibilities in
[`../../docs/architecture/messaging.md`](../../docs/architecture/messaging.md#router).
